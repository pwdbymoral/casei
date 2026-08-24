import { randomUUID } from "node:crypto";
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
