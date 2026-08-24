import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { ensureApplicationRole } from "../src/roles.js";

const adminUrl = process.env.DATABASE_URL_TEST;

if (!adminUrl) {
  if (process.env.CI) {
    throw new Error("DATABASE_URL_TEST is required for database integration tests in CI");
  }
  test("aplica e reverte migration, isola dois espaços e preserva auditoria", {
    skip: "DATABASE_URL_TEST is not configured",
  }, () => {});
} else {
  test("aplica e reverte migration, isola dois espaços e preserva auditoria", async () => {
    const adminPool = new Pool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_plat001_${suffix}`;
    const databaseIdentifier = `"${databaseName}"`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: Pool | undefined;

    try {
      await ensureApplicationRole(adminPool);
      const unsafeRole = `casei_plat001_unsafe_${suffix}`;
      const ownershipRole = `casei_plat001_owner_${suffix}`;
      const ownedTable = `casei_plat001_owned_${suffix}`;
      try {
        await adminPool.query(`CREATE ROLE "${unsafeRole}" NOLOGIN SUPERUSER`);
        await assert.rejects(
          ensureApplicationRole(adminPool, unsafeRole),
          new RegExp(`${unsafeRole} must remain a non-superuser role without BYPASSRLS`),
        );

        await adminPool.query(`CREATE ROLE "${ownershipRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await adminPool.query(`CREATE TABLE "${ownedTable}" (id integer)`);
        await adminPool.query(`ALTER TABLE "${ownedTable}" OWNER TO "${ownershipRole}"`);
        await assert.rejects(
          ensureApplicationRole(adminPool, ownershipRole),
          new RegExp(`${ownershipRole} must not own table public\\.${ownedTable}`),
        );
      } finally {
        await adminPool.query(`DROP TABLE IF EXISTS "${ownedTable}"`);
        await adminPool.query(`DROP ROLE IF EXISTS "${ownershipRole}"`);
        await adminPool.query(`DROP ROLE IF EXISTS "${unsafeRole}"`);
      }

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
      await pool.query(
        `INSERT INTO "audit_event"
          (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result, reason)
         VALUES ('security', 'schema_test', $1, $2, 'workspace', $3, 'test', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success', 'fixture')`,
        [firstUser, firstWorkspaceId, firstWorkspaceId],
      );
      await pool.query(
        `INSERT INTO user_preference (user_id, locale, hide_values) VALUES ($1, 'pt-BR', false)`,
        [firstUser],
      );

      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'casei_app'`,
      );
      assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });

      const appClient = await pool.connect();
      try {
        await appClient.query("SET ROLE casei_app");
        await appClient.query("BEGIN");
        try {
          await appClient.query(`SELECT set_config('app.workspace_id', $1, true)`, [
            firstWorkspaceId,
          ]);
          await appClient.query(`SELECT set_config('app.actor_id', $1, true)`, [firstUser]);
          const visible = await appClient.query<{ id: string }>(
            `SELECT id FROM "workspace" ORDER BY id`,
          );
          assert.deepEqual(
            visible.rows.map((row) => row.id),
            [firstWorkspaceId],
          );

          const visiblePreferences = await appClient.query<{ user_id: string }>(
            `SELECT user_id FROM user_preference`,
          );
          assert.deepEqual(visiblePreferences.rows, [{ user_id: firstUser }]);
          await appClient.query("SAVEPOINT user_preference_cross_workspace_attempt");
          await assert.rejects(
            appClient.query(
              `INSERT INTO user_preference (user_id, locale, hide_values)
               VALUES ($1, 'pt-BR', false)`,
              [secondUser],
            ),
          );
          await appClient.query("ROLLBACK TO SAVEPOINT user_preference_cross_workspace_attempt");

          await appClient.query("SAVEPOINT cross_workspace_attempt");
          await assert.rejects(
            appClient.query(
              `INSERT INTO "membership" (workspace_id, user_id, role)
               VALUES ($1, $2, 'viewer')`,
              [secondWorkspaceId, secondUser],
            ),
          );
          await appClient.query("ROLLBACK TO SAVEPOINT cross_workspace_attempt");

          await appClient.query("SAVEPOINT audit_update_attempt");
          await assert.rejects(
            appClient.query(
              `UPDATE "audit_event" SET reason = 'tampered'
               WHERE workspace_id = $1`,
              [firstWorkspaceId],
            ),
          );
          await appClient.query("ROLLBACK TO SAVEPOINT audit_update_attempt");

          await appClient.query("SAVEPOINT audit_delete_attempt");
          await assert.rejects(
            appClient.query(`DELETE FROM "audit_event" WHERE workspace_id = $1`, [
              firstWorkspaceId,
            ]),
          );
          await appClient.query("ROLLBACK TO SAVEPOINT audit_delete_attempt");

          await appClient.query("COMMIT");
        } catch (error) {
          await appClient.query("ROLLBACK");
          throw error;
        }
        const failClosed = await appClient.query(`SELECT id FROM "workspace"`);
        assert.equal(failClosed.rowCount, 0);
      } finally {
        try {
          await appClient.query("RESET ROLE");
        } finally {
          appClient.release();
        }
      }

      const rls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = 'workspace'::regclass`,
      );
      assert.deepEqual(rls.rows[0], {
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      const auditRedactionDownSql = await readFile(
        fileURLToPath(new URL("../drizzle/0005_audit_redacted_fields.down.sql", import.meta.url)),
        "utf8",
      );
      await pool.query(auditRedactionDownSql);
      const profileDownSql = await readFile(
        fileURLToPath(new URL("../drizzle/0004_profile_preferences.down.sql", import.meta.url)),
        "utf8",
      );
      await pool.query(profileDownSql);
      const downSql = await readFile(
        fileURLToPath(new URL("../drizzle/0003_identity_workspaces.down.sql", import.meta.url)),
        "utf8",
      );
      await pool.query(downSql);
      const baseDownSql = await readFile(
        fileURLToPath(new URL("../drizzle/0000_ambitious_madrox.down.sql", import.meta.url)),
        "utf8",
      );
      await pool.query(baseDownSql);
      const remainingTables = await pool.query<{ tablename: string }>(
        `SELECT tablename
         FROM pg_catalog.pg_tables
         WHERE schemaname = 'public'
           AND tablename IN (
             'audit_event', 'auth_email_intent', 'auth_email_outbox',
             'idempotency_key', 'job', 'membership', 'outbox_event',
             'workspace_preference', 'workspace', 'account', 'session',
             'user', 'verification', 'workspace_invitation',
             'workspace_deletion_recovery', 'workspace_tombstone',
             'workspace_invitation_rate_limit', 'user_preference'
           )
         ORDER BY tablename`,
      );
      assert.deepEqual(remainingTables.rows, []);
      const remainingSchemas = await pool.query<{ nspname: string }>(
        `SELECT nspname
         FROM pg_namespace
         WHERE nspname IN ('app', 'drizzle')
         ORDER BY nspname`,
      );
      assert.deepEqual(remainingSchemas.rows, []);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseIdentifier} WITH (FORCE)`);
      await adminPool.end();
    }
  });
}
