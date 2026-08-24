import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { IdentityService } from "../src/identity-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

type TestPool = ReturnType<typeof getDatabasePool>;

describe("IdentityService canonical lock order PostgreSQL", () => {
  integrationIt(
    "does not deadlock stock-style membership/workspace locking with transfer",
    async () => {
      if (!adminUrl) return;
      const fixture = await createFixture(adminUrl, "transfer");
      try {
        const service = new IdentityService(fixture.pool, {
          authEmailSecret: "test-secret-that-is-longer-than-thirty-two-characters",
        });
        await expect(
          runAgainstStockStyleLock(fixture.pool, fixture.workspaceId, fixture.targetId, () =>
            service.transferOwnership(fixture.scope, fixture.targetId, 0),
          ),
        ).resolves.toEqual({ version: 1 });
      } finally {
        await fixture.close();
      }
    },
  );

  integrationIt(
    "does not deadlock stock-style membership/workspace locking with deactivation",
    async () => {
      if (!adminUrl) return;
      const fixture = await createFixture(adminUrl, "deactivate");
      try {
        const service = new IdentityService(fixture.pool, {
          authEmailSecret: "test-secret-that-is-longer-than-thirty-two-characters",
        });
        await expect(
          runAgainstStockStyleLock(fixture.pool, fixture.workspaceId, fixture.targetId, () =>
            service.deactivateWorkspace(
              fixture.scope,
              { workspaceName: "Casa lock order", reason: "regressão" },
              0,
            ),
          ),
        ).resolves.toMatchObject({ version: 1 });
      } finally {
        await fixture.close();
      }
    },
  );
});

async function createFixture(adminConnectionString: string, label: string) {
  const adminPool = getDatabasePool({ connectionString: adminConnectionString });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_lock_order_${label}_${suffix}`;
  const databaseUrl = new URL(adminConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: TestPool | undefined;
  const ownerId = `lock-order-owner-${suffix}`;
  const targetId = `lock-order-target-${suffix}`;

  try {
    await ensureApplicationRole(adminPool);
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = getDatabasePool({ connectionString: databaseUrl.toString() });
    await migrate(createDatabase(pool), {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES
        ($1, 'Lock owner', $3, true), ($2, 'Lock target', $4, true)`,
      [ownerId, targetId, `${ownerId}@example.test`, `${targetId}@example.test`],
    );
    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspace (name) VALUES ('Casa lock order') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    await pool.query(
      `INSERT INTO workspace_preference (workspace_id, currency_code, timezone)
       VALUES ($1, 'BRL', 'America/Fortaleza')`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO membership (workspace_id, user_id, role, status) VALUES
        ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
      [workspaceId, ownerId, targetId],
    );

    return {
      pool,
      workspaceId,
      targetId,
      scope: {
        actor: { userId: ownerId, email: `${ownerId}@example.test`, recentAuthentication: true },
        workspaceId,
        role: "owner" as const,
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      async close() {
        await pool?.end();
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await adminPool.end();
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await adminPool
      .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await adminPool.end();
    throw error;
  }
}

async function runAgainstStockStyleLock(
  pool: TestPool,
  workspaceId: string,
  targetId: string,
  identityOperation: () => Promise<unknown>,
): Promise<unknown> {
  const workspaceGate = await pool.connect();
  const stockStyle = await pool.connect();
  let identityAttempt: Promise<unknown> | undefined;
  try {
    await workspaceGate.query("BEGIN");
    await workspaceGate.query(`SELECT id FROM workspace WHERE id = $1 FOR UPDATE`, [workspaceId]);
    await stockStyle.query("BEGIN");
    await stockStyle.query(
      `SELECT user_id FROM membership
        WHERE workspace_id = $1 AND user_id = $2
        FOR UPDATE`,
      [workspaceId, targetId],
    );

    // Starting identity first makes the old workspace-first implementation win
    // the workspace lock queue and exposes the cycle deterministically.
    identityAttempt = identityOperation();
    await delay(50);
    const stockWorkspaceAttempt = stockStyle.query(
      `SELECT id FROM workspace WHERE id = $1 FOR UPDATE`,
      [workspaceId],
    );
    await workspaceGate.query("COMMIT");
    await withTimeout(stockWorkspaceAttempt);
    await stockStyle.query("COMMIT");
    return await withTimeout(identityAttempt);
  } finally {
    await workspaceGate.query("ROLLBACK").catch(() => undefined);
    await stockStyle.query("ROLLBACK").catch(() => undefined);
    workspaceGate.release();
    stockStyle.release();
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("lock-order regression timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
