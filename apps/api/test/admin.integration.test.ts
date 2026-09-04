import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { PostgresAdminAccountStore } from "../src/admin-store.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("ADMIN PostgreSQL boundary", () => {
  integrationIt("reads third-party workspace metadata through controlled functions", async () => {
    if (!adminUrl) return;
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_admin_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      pool.on("error", () => undefined);
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
      const adminId = `admin-${suffix}`;
      const targetId = `target-${suffix}`;
      const user = await pool.query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ($1, 'Admin', $2, true), ($3, 'Pessoa', $4, true)
         RETURNING id`,
        [adminId, `${adminId}@example.test`, targetId, `${targetId}@example.test`],
      );
      expect(user.rows).toHaveLength(2);
      await pool.query(
        `INSERT INTO platform_account (user_id, role, status, version)
         VALUES ($1, 'platform_admin', 'active', 1)`,
        [adminId],
      );
      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspace (name, status) VALUES ('Casa terceira', 'active') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO membership (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [workspace.rows[0]?.id, targetId],
      );

      const store = new PostgresAdminAccountStore(pool);
      const detail = await store.withActor(adminId, () => store.getAccount(targetId));
      expect(detail?.workspaces).toEqual([
        { id: workspace.rows[0]?.id, name: "Casa terceira", status: "active" },
      ]);
      expect(detail?.workspaceCount).toBe(1);

      const restricted = await pool.connect();
      try {
        await restricted.query("BEGIN");
        await restricted.query('SET LOCAL ROLE "casei_app"');
        await restricted.query(`SELECT set_config('app.actor_id', $1, false)`, [targetId]);
        const boundaryRole = await restricted.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          function_owner: string;
        }>(
          `SELECT r.rolsuper, r.rolbypassrls, owner_role.rolname AS function_owner
             FROM pg_roles r
             JOIN pg_proc p ON p.proname = 'platform_account_metadata'
             JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'app'
             JOIN pg_roles owner_role ON owner_role.oid = p.proowner
            WHERE r.rolname = 'casei_platform_boundary'`,
        );
        expect(boundaryRole.rows[0]).toEqual({
          rolsuper: false,
          rolbypassrls: false,
          function_owner: "casei_platform_boundary",
        });
        const actorRole = await restricted.query<{ role: string | null }>(
          `SELECT app.current_platform_role() AS role`,
        );
        expect(actorRole.rows[0]?.role).toBeNull();
        const hidden = await restricted.query<{ workspace_count: string }>(
          `SELECT workspace_count FROM app.platform_account_metadata($1)`,
          [targetId],
        );
        const hiddenWorkspaces = await restricted.query(
          `SELECT id FROM app.platform_account_workspaces($1)`,
          [targetId],
        );
        expect(hidden.rows[0]?.workspace_count).toBe("0");
        expect(hiddenWorkspaces.rows).toHaveLength(0);
        const privileges = await restricted.query<{
          function_name: string;
          app_execute: boolean;
          public_execute: boolean;
        }>(
          `SELECT p.proname AS function_name,
                  has_function_privilege('casei_app', p.oid, 'EXECUTE') AS app_execute,
                  COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'), false) AS public_execute
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
             LEFT JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl ON true
            WHERE n.nspname = 'app'
              AND p.proname IN (
                'current_platform_role', 'platform_role_for_user', 'platform_status_for_user',
                'platform_account_metadata', 'platform_account_workspaces',
                'assert_platform_session_allowed', 'lock_platform_session_user',
                'guard_platform_session_insert', 'claim_first_platform_admin'
              )
            GROUP BY p.oid, p.proname
            ORDER BY p.proname`,
        );
        expect(privileges.rows.length).toBe(9);
        expect(privileges.rows.every((row) => row.app_execute && !row.public_execute)).toBe(true);
        await restricted.query("ROLLBACK");
      } finally {
        restricted.release();
      }
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });

  integrationIt("serializes suspension and session insertion with one advisory lock", async () => {
    if (!adminUrl) return;
    const adminPool = getDatabasePool({ connectionString: adminUrl });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `casei_admin_race_${suffix}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: ReturnType<typeof getDatabasePool> | undefined;
    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = getDatabasePool({ connectionString: databaseUrl.toString() });
      pool.on("error", () => undefined);
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
      const userId = `race-${suffix}`;
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Race', $2, true)`,
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO platform_account (user_id, role, status, version)
         VALUES ($1, 'platform_support', 'active', 1)`,
        [userId],
      );
      const suspender = await pool.connect();
      const signer = await pool.connect();
      // A failed trigger query can emit a late client error while the
      // disposable database is being dropped; consume it after the assertion
      // so teardown cannot turn a proven rejection into an unhandled error.
      suspender.on("error", () => undefined);
      signer.on("error", () => undefined);
      try {
        await suspender.query("BEGIN");
        await suspender.query(`SELECT app.lock_platform_session_user($1)`, [userId]);
        await signer.query("BEGIN");
        const pendingInsert = signer.query(
          `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
           VALUES ($1, now() + interval '1 hour', $2, now(), now(), $3)`,
          [`session-${suffix}`, `token-${suffix}`, userId],
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        await suspender.query(
          `UPDATE platform_account SET status = 'suspended', version = version + 1 WHERE user_id = $1`,
          [userId],
        );
        await suspender.query("COMMIT");
        await expect(pendingInsert).rejects.toMatchObject({ code: "28000" });
        await signer.query("ROLLBACK");
      } finally {
        await suspender.query("ROLLBACK").catch(() => undefined);
        await signer.query("ROLLBACK").catch(() => undefined);
        suspender.release();
        signer.release();
      }
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });
});
