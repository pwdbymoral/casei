import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, ensureApplicationRole, getDatabasePool } from "../src/index.js";

test("migration de estoque preserva histórico, RLS e invariantes de quantidade", async () => {
  const sql = await readFile(
    fileURLToPath(new URL("../drizzle/0006_stock_core.sql", import.meta.url)),
    "utf8",
  );
  const down = await readFile(
    fileURLToPath(new URL("../drizzle/0006_stock_core.down.sql", import.meta.url)),
    "utf8",
  );
  const shopping = await readFile(
    fileURLToPath(new URL("../drizzle/0007_stock_shopping.sql", import.meta.url)),
    "utf8",
  );
  const shoppingDown = await readFile(
    fileURLToPath(new URL("../drizzle/0007_stock_shopping.down.sql", import.meta.url)),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "stock_product"/);
  assert.match(sql, /stock_product_active_name_unique/);
  assert.match(sql, /WHERE "archived" = false/);
  assert.match(sql, /"quantity_milli" >= 0/);
  assert.match(sql, /"unit_label" is not null and length\(trim\("unit_label"\)\) > 0/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /stock_movement_immutable_guard/);
  assert.match(sql, /stock_movement_product_scope_fk[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON stock_product FROM casei_app/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON stock_movement FROM casei_app/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON stock_product/);
  assert.doesNotMatch(sql, /GRANT .*DELETE ON stock_product/);
  assert.match(down, /DROP TABLE IF EXISTS stock_movement/);
  assert.match(down, /DROP TABLE IF EXISTS stock_product/);
  assert.match(shopping, /ADD COLUMN "shopping_auto" boolean/);
  assert.match(shopping, /shopping_item_active_name_unique/);
  assert.match(shopping, /shopping_item_source_product_check/);
  assert.match(shopping, /shopping_item_product_scope_fk[\s\S]*ON DELETE CASCADE/);
  assert.match(shopping, /CONSTRAINT "shopping_item_event_item_scope_fk"[\s\S]*ON DELETE CASCADE/);
  assert.match(shopping, /shopping_item_event_immutable_guard/);
  assert.match(shopping, /FORCE ROW LEVEL SECURITY/);
  assert.match(shopping, /REVOKE DELETE ON shopping_item FROM casei_app/);
  assert.match(shopping, /REVOKE UPDATE, DELETE ON shopping_item_event FROM casei_app/);
  assert.doesNotMatch(shopping, /GRANT .*DELETE ON shopping_item/);
  assert.match(shoppingDown, /DROP TABLE IF EXISTS shopping_item_event/);
  assert.match(shoppingDown, /DROP COLUMN IF EXISTS "shopping_auto"/);
});

const adminUrl = process.env.DATABASE_URL_TEST;

if (!adminUrl) {
  test("role de estoque restringe DML", { skip: "DATABASE_URL_TEST is not configured" }, () => {});
} else {
  test("role de aplicação não pode apagar nem atualizar o histórico do estoque", async () => {
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_stock_schema_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Stock privilege test') RETURNING id`,
      );
      const workspaceId = workspace.rows[0]?.id;
      assert.ok(workspaceId);
      const authorId = `stock-schema-${suffix}`;
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ($1, 'Stock tester', $2, true)`,
        [authorId, `${authorId}@example.test`],
      );

      const client = await pool.connect();
      try {
        await client.query("SET ROLE casei_app");
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        await client.query(`SELECT set_config('app.actor_id', $1, true)`, [authorId]);
        const privileges = await client.query<{
          product_delete: boolean;
          product_insert: boolean;
          product_update: boolean;
          movement_delete: boolean;
          movement_insert: boolean;
          movement_update: boolean;
          shopping_item_delete: boolean;
          shopping_item_event_insert: boolean;
          shopping_item_event_update: boolean;
          shopping_item_event_delete: boolean;
        }>(
          `SELECT
             has_table_privilege(current_user, 'stock_product', 'DELETE') AS product_delete,
             has_table_privilege(current_user, 'stock_product', 'INSERT') AS product_insert,
             has_table_privilege(current_user, 'stock_product', 'UPDATE') AS product_update,
             has_table_privilege(current_user, 'stock_movement', 'DELETE') AS movement_delete,
             has_table_privilege(current_user, 'stock_movement', 'INSERT') AS movement_insert,
             has_table_privilege(current_user, 'stock_movement', 'UPDATE') AS movement_update,
             has_table_privilege(current_user, 'shopping_item', 'DELETE') AS shopping_item_delete,
             has_table_privilege(current_user, 'shopping_item_event', 'INSERT') AS shopping_item_event_insert,
             has_table_privilege(current_user, 'shopping_item_event', 'UPDATE') AS shopping_item_event_update,
             has_table_privilege(current_user, 'shopping_item_event', 'DELETE') AS shopping_item_event_delete`,
        );
        assert.deepEqual(privileges.rows[0], {
          product_delete: false,
          product_insert: true,
          product_update: true,
          movement_delete: false,
          movement_insert: true,
          movement_update: false,
          shopping_item_delete: false,
          shopping_item_event_insert: true,
          shopping_item_event_update: false,
          shopping_item_event_delete: false,
        });
        const product = await client.query<{ id: string }>(
          `INSERT INTO stock_product (workspace_id, name, name_normalized)
           VALUES ($1, 'Arroz', 'arroz') RETURNING id`,
          [workspaceId],
        );
        const productId = product.rows[0]?.id;
        assert.ok(productId);
        await client.query(
          `INSERT INTO stock_movement
           (workspace_id, product_id, kind, quantity_milli, author_id)
           VALUES ($1, $2, 'entry', 1000, $3)`,
          [workspaceId, productId, authorId],
        );
        await assert.rejects(
          client.query(`DELETE FROM stock_product WHERE id = $1`, [productId]),
          /permission denied/,
        );
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        await client.query(`SELECT set_config('app.actor_id', $1, true)`, [authorId]);
        await assert.rejects(
          client.query(`UPDATE stock_movement SET reason = 'tampered' WHERE product_id = $1`, [
            productId,
          ]),
          /permission denied/,
        );
        await client.query("ROLLBACK");
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  });
}
