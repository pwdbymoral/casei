import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureApplicationRole } from "../src/roles.js";

const adminUrl = process.env.DATABASE_URL_TEST;

if (!adminUrl) {
  test.skip("aplica migration, isola dois espaços e remove o banco descartável");
} else {
  test("aplica migration, isola dois espaços e remove o banco descartável", async () => {
    const adminPool = new Pool({ connectionString: adminUrl });
    const databaseName = `casei_plat001_${process.pid}_${Date.now()}`;
    const databaseIdentifier = `"${databaseName}"`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: Pool | undefined;

    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE ${databaseIdentifier}`);
      pool = new Pool({ connectionString: databaseUrl.toString() });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });

      const firstUser = "user-plat001-a";
      const secondUser = "user-plat001-b";
      const firstWorkspace = await pool.query<{ id: string }>(
        `INSERT INTO "workspace" (name) VALUES ('Casa A') RETURNING id`,
      );
      const secondWorkspace = await pool.query<{ id: string }>(
        `INSERT INTO "workspace" (name) VALUES ('Casa B') RETURNING id`,
      );
      const firstWorkspaceId = firstWorkspace.rows[0]?.id;
      const secondWorkspaceId = secondWorkspace.rows[0]?.id;
      assert.ok(firstWorkspaceId);
      assert.ok(secondWorkspaceId);
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES
          ($1, 'Pessoa A', 'plat001-a@example.test', true),
          ($2, 'Pessoa B', 'plat001-b@example.test', true)`,
        [firstUser, secondUser],
      );
      await pool.query(
        `INSERT INTO "membership" (workspace_id, user_id, role) VALUES
          ($1, $3, 'owner'),
          ($2, $4, 'owner')`,
        [firstWorkspaceId, secondWorkspaceId, firstUser, secondUser],
      );

      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'casei_app'`,
      );
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });

      const appClient = await pool.connect();
      try {
        await appClient.query("SET ROLE casei_app");
        await appClient.query(`SELECT set_config('app.workspace_id', $1, true)`, [
          firstWorkspaceId,
        ]);
        const visible = await appClient.query<{ id: string }>(
          `SELECT id FROM "workspace" ORDER BY id`,
        );
        assert.deepEqual(
          visible.rows.map((row) => row.id),
          [firstWorkspaceId],
        );

        await assert.rejects(
          appClient.query(
            `INSERT INTO "membership" (workspace_id, user_id, role)
             VALUES ($1, $2, 'viewer')`,
            [secondWorkspaceId, secondUser],
          ),
        );

        await appClient.query(`SELECT set_config('app.workspace_id', '', true)`);
        const failClosed = await appClient.query(`SELECT id FROM "workspace"`);
        assert.equal(failClosed.rowCount, 0);
      } finally {
        appClient.release();
      }

      const rls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = 'workspace'::regclass`,
      );
      assert.deepEqual(rls.rows[0], {
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE ${databaseIdentifier} WITH (FORCE)`);
      await adminPool.end();
    }
  });
}
