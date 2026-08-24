import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { StockPermissionError, StockService } from "../src/stock-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("STOCK autorização PostgreSQL", () => {
  integrationIt("revalida workspace/membership sob retry e serializa troca de papel", async () => {
    if (!adminUrl) return;
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_stock_service_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    const ownerId = `stock-owner-${suffix}`;
    const memberId = `stock-member-${suffix}`;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Stock authorization') RETURNING id`,
      );
      const workspaceId = workspace.rows[0]?.id;
      expect(workspaceId).toBeTruthy();
      if (!workspaceId) throw new Error("workspace was not created");
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES
          ($1, 'Stock owner', $3, true), ($2, 'Stock member', $4, true)`,
        [ownerId, memberId, `${ownerId}@example.test`, `${memberId}@example.test`],
      );
      await pool.query(
        `INSERT INTO membership (workspace_id, user_id, role, status) VALUES
          ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
        [workspaceId, ownerId, memberId],
      );

      const service = new StockService(pool);
      const scope = {
        workspaceId,
        actorId: memberId,
        correlationId: `stock-correlation-${suffix}`,
        role: "member" as const,
      };
      const created = await service.createProduct(
        scope,
        { name: "Arroz", quantity: "1" },
        "stock-service-create-integration-001",
      );
      expect(created.product.quantity).toBe("1");

      await pool.query(
        `UPDATE membership SET role = 'viewer', version = version + 1
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );
      await expect(
        service.createMovement(
          scope,
          created.product.id,
          { kind: "entry", quantity: "1" },
          "stock-service-movement-revoked-001",
          created.product.version,
        ),
      ).rejects.toBeInstanceOf(StockPermissionError);

      await pool.query(
        `UPDATE membership SET role = 'member', version = version + 1
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );

      const ownerScope = {
        ...scope,
        actorId: ownerId,
        role: "owner" as const,
        correlationId: `stock-owner-correlation-${suffix}`,
      };
      const concurrentCollision = await Promise.allSettled([
        service.updateProduct(
          scope,
          created.product.id,
          { name: "Feijão" },
          created.product.version,
        ),
        service.createShoppingItem(ownerScope, { name: "Feijão" }, "stock-shopping-collision-0001"),
      ]);
      expect(concurrentCollision.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrentCollision.filter((result) => result.status === "rejected")).toHaveLength(1);
      const productCollision = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM stock_product
          WHERE workspace_id = $1 AND name_normalized = 'feijao' AND archived = false`,
        [workspaceId],
      );
      const itemCollision = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM shopping_item
          WHERE workspace_id = $1 AND name_normalized = 'feijao' AND purchased = false`,
        [workspaceId],
      );
      expect(
        Number(productCollision.rows[0]?.count ?? 0) + Number(itemCollision.rows[0]?.count ?? 0),
      ).toBeLessThanOrEqual(1);

      const bulkRaceProduct = await service.createProduct(
        ownerScope,
        { name: "Batata", quantity: "1" },
        "stock-bulk-race-product-001",
      );
      const bulkRaceContent = "Nome\tQuantidade\nCenoura\t1";
      const bulkRaceHash = createHash("sha256").update(bulkRaceContent, "utf8").digest("hex");
      const patchBulkCollision = await Promise.allSettled([
        service.updateProduct(
          scope,
          bulkRaceProduct.product.id,
          { name: "Cenoura" },
          bulkRaceProduct.product.version,
        ),
        service.applyBulkProducts(
          ownerScope,
          { content: bulkRaceContent, mode: "valid_only", previewHash: bulkRaceHash },
          "stock-bulk-race-apply-001",
        ),
      ]);
      expect(patchBulkCollision).toHaveLength(2);
      for (const result of patchBulkCollision) {
        if (result.status === "rejected") {
          expect((result.reason as { code?: string }).code).not.toBe("40P01");
        }
      }

      const restoreRaceProduct = await service.createProduct(
        ownerScope,
        { name: "Farinha" },
        "stock-restore-race-product-001",
      );
      const archived = await service.setArchived(
        ownerScope,
        restoreRaceProduct.product.id,
        true,
        "stock-restore-race-archive-001",
        restoreRaceProduct.product.version,
      );
      const patchRestoreCollision = await Promise.allSettled([
        service.updateProduct(
          scope,
          restoreRaceProduct.product.id,
          { note: "Atualizado em paralelo" },
          archived.product.version,
        ),
        service.setArchived(
          ownerScope,
          restoreRaceProduct.product.id,
          false,
          "stock-restore-race-restore-001",
          archived.product.version,
        ),
      ]);
      expect(patchRestoreCollision.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(patchRestoreCollision.filter((result) => result.status === "rejected")).toHaveLength(
        1,
      );
      for (const result of patchRestoreCollision) {
        if (result.status === "rejected") {
          expect((result.reason as { code?: string }).code).not.toBe("40P01");
        }
      }

      const lockClient = await pool.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `SELECT id FROM membership WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
          [workspaceId, memberId],
        );
        await lockClient.query(
          `UPDATE membership SET role = 'viewer', version = version + 1
            WHERE workspace_id = $1 AND user_id = $2`,
          [workspaceId, memberId],
        );
        const blocked = service.createMovement(
          scope,
          created.product.id,
          { kind: "entry", quantity: "1" },
          "stock-service-movement-concurrent-001",
          created.product.version,
        );
        await lockClient.query("COMMIT");
        await expect(blocked).rejects.toBeInstanceOf(StockPermissionError);
      } finally {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        lockClient.release();
      }

      await pool.query(`UPDATE workspace SET status = 'deactivated' WHERE id = $1`, [workspaceId]);
      await expect(service.listProducts(scope)).rejects.toBeInstanceOf(StockPermissionError);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  });
});

describe("STOCK-006 vínculo explícito com despesa PostgreSQL", () => {
  integrationIt("persiste somente o vínculo escolhido no mesmo espaço", async () => {
    if (!adminUrl) return;
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_stock_purchase_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    const actorId = `stock-purchase-owner-${suffix}`;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Stock purchase link') RETURNING id`,
      );
      const workspaceId = workspace.rows[0]?.id;
      expect(workspaceId).toBeTruthy();
      if (!workspaceId) throw new Error("workspace was not created");
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ($1, 'Stock purchase owner', $2, true)`,
        [actorId, `${actorId}@example.test`],
      );
      await pool.query(
        `INSERT INTO membership (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [workspaceId, actorId],
      );
      const expense = await pool.query<{ id: string }>(
        `INSERT INTO finance_transaction
           (workspace_id, kind, state, instrument, amount_minor, settled_minor,
            currency_code, occurred_on, posted_on, cash_settled_on, description)
         VALUES ($1, 'expense', 'posted', 'wallet', 1250, 1250, 'BRL', '2026-08-24', now(), now(), 'Compra do mercado')
         RETURNING id`,
        [workspaceId],
      );
      const expenseId = expense.rows[0]?.id;
      expect(expenseId).toBeTruthy();
      if (!expenseId) throw new Error("expense was not created");

      const service = new StockService(pool);
      const scope = {
        workspaceId,
        actorId,
        correlationId: `stock-purchase-correlation-${suffix}`,
        role: "owner" as const,
      };
      const product = await service.createProduct(
        scope,
        { name: "Arroz", quantity: "0", minimum: "1" },
        "stock-purchase-product-001",
      );
      const item = (await service.listShoppingItems(scope)).find(
        (candidate) => candidate.productId === product.product.id,
      );
      expect(item).toBeTruthy();
      if (!item) throw new Error("shopping item was not derived");

      const completed = await service.purchaseShoppingItem(
        scope,
        item.id,
        { addToStock: false, expenseTransactionId: expenseId },
        "stock-purchase-link-001",
        item.version,
      );
      expect(completed.item.expenseTransactionId).toBe(expenseId);
      const persisted = await pool.query<{ expense_transaction_id: string | null }>(
        `SELECT expense_transaction_id FROM shopping_item WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, item.id],
      );
      expect(persisted.rows[0]?.expense_transaction_id).toBe(expenseId);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  });
});
