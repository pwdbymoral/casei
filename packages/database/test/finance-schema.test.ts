import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureApplicationRole } from "../src/roles.js";

const adminUrl = process.env.DATABASE_URL_TEST;

if (!adminUrl) {
  test("preserva ledger publicado com role de aplicação", {
    skip: "DATABASE_URL_TEST is not configured",
  }, () => {});
} else {
  test("executa ledger financeiro com casei_app e impede mutação de evento publicado", async () => {
    const adminPool = new Pool({ connectionString: adminUrl });
    const databaseName = `casei_fin_${process.pid}_${Date.now()}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: Pool | undefined;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = new Pool({ connectionString: databaseUrl.toString() });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });

      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name) VALUES ('Finance schema') RETURNING id`,
      );
      const workspaceId = workspace.rows[0]?.id;
      assert.ok(workspaceId);

      const client = await pool.connect();
      try {
        await client.query("SET ROLE casei_app");
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        const identity = await client.query<{ current_user: string; current_role: string }>(
          `SELECT current_user, current_role`,
        );
        assert.deepEqual(identity.rows[0], {
          current_user: "casei_app",
          current_role: "casei_app",
        });
        const accounts = await client.query<{ id: string }>(
          `INSERT INTO financial_account (workspace_id, kind, name, currency_code)
           VALUES ($1, 'wallet', 'Carteira', 'BRL'), ($1, 'expense', 'Despesas', 'BRL')
           RETURNING id`,
          [workspaceId],
        );
        const event = await client.query<{ id: string }>(
          `INSERT INTO ledger_event (workspace_id, event_type, currency_code, status, occurred_on, published_at)
           VALUES ($1, 'test.published.v1', 'BRL', 'published', '2026-08-23', now()) RETURNING id`,
          [workspaceId],
        );
        assert.ok(event.rows[0]?.id);
        await client.query(
          `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor)
           VALUES ($1, $2, $3, 'BRL', 100), ($1, $2, $4, 'BRL', -100)`,
          [workspaceId, event.rows[0]?.id, accounts.rows[0]?.id, accounts.rows[1]?.id],
        );
        await client.query("COMMIT");
        // The first context was transaction-local. Re-establish the scope for
        // the post-commit negative checks so RLS does not turn the UPDATE into
        // a silent zero-row operation before the immutable trigger can run.
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [workspaceId]);

        await assert.rejects(
          client.query(`UPDATE ledger_event SET occurred_on = '2026-08-24' WHERE id = $1`, [
            event.rows[0]?.id,
          ]),
          /published ledger event is immutable/,
        );
        await assert.rejects(
          client.query(`DELETE FROM ledger_entry WHERE event_id = $1`, [event.rows[0]?.id]),
          /published ledger entries are immutable/,
        );
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
