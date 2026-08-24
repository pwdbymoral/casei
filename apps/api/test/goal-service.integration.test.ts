import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { GoalService } from "../src/goal-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("GOAL reserve concurrency PostgreSQL", () => {
  integrationIt("aggregates reservations across goals in sequential allocations", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.goalService.createGoal(
        fixture.scope,
        { name: "Viagem", target: { currency: "BRL", minor: "1000" } },
        "goal-sequential-create-1",
      );
      const second = await fixture.goalService.createGoal(
        fixture.scope,
        { name: "Reforma", target: { currency: "BRL", minor: "1000" } },
        "goal-sequential-create-2",
      );

      const firstAllocation = await fixture.goalService.allocateGoal(
        fixture.scope,
        first.goal.id,
        { amount: { currency: "BRL", minor: "60" } },
        "goal-sequential-allocate-1",
        first.goal.version,
      );
      const secondAllocation = await fixture.goalService.allocateGoal(
        fixture.scope,
        second.goal.id,
        { amount: { currency: "BRL", minor: "40" } },
        "goal-sequential-allocate-2",
        second.goal.version,
      );

      expect(firstAllocation.goal.reserved.minor).toBe("60");
      expect(secondAllocation.goal.reserved.minor).toBe("40");
      await expect(
        fixture.goalService.allocateGoal(
          fixture.scope,
          second.goal.id,
          { amount: { currency: "BRL", minor: "1" } },
          "goal-sequential-allocate-3",
          secondAllocation.goal.version,
        ),
      ).rejects.toMatchObject({ code: "validation_failed" });
    } finally {
      await fixture.close();
    }
  });

  integrationIt("serializes concurrent allocations across different goals", async () => {
    const fixture = await createFixture();
    try {
      const goals = await Promise.all(
        ["A", "B"].map((name, index) =>
          fixture.goalService.createGoal(
            fixture.scope,
            { name: `Concorrente ${name}`, target: { currency: "BRL", minor: "1000" } },
            `goal-concurrent-create-${index}`,
          ),
        ),
      );
      const results = await Promise.allSettled(
        goals.map((result, index) =>
          fixture.goalService.allocateGoal(
            fixture.scope,
            result.goal.id,
            { amount: { currency: "BRL", minor: "60" } },
            `goal-concurrent-allocate-${index}`,
            result.goal.version,
          ),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { code: "validation_failed" },
      });
      const aggregate = await fixture.pool.query<{ reserved_minor: string }>(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'allocate' THEN amount_minor
                                 WHEN kind IN ('release', 'spend') THEN -amount_minor
                                 ELSE 0 END), 0) AS reserved_minor
           FROM goal_reservation_movement WHERE workspace_id = $1`,
        [fixture.workspaceId],
      );
      expect(aggregate.rows[0]?.reserved_minor).toBe("60");
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_goal_${suffix}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: ReturnType<typeof getDatabasePool> | undefined;
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
      `INSERT INTO workspace (name) VALUES ('Casa metas') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    const actorId = `goal-owner-${suffix}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Owner', $2, true)`,
      [actorId, `${actorId}@example.test`],
    );
    await pool.query(
      `INSERT INTO workspace_preference (workspace_id, currency_code, timezone)
       VALUES ($1, 'BRL', 'America/Fortaleza')`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO membership (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [workspaceId, actorId],
    );
    const accounts = await pool.query<{ wallet_id: string; income_id: string }>(
      `WITH wallet AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'wallet', 'Carteira', 'BRL') RETURNING id
       ), income AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'income', 'Receitas', 'BRL') RETURNING id
       )
       SELECT wallet.id AS wallet_id, income.id AS income_id FROM wallet, income`,
      [workspaceId],
    );
    const walletId = accounts.rows[0]?.wallet_id;
    const incomeId = accounts.rows[0]?.income_id;
    if (!walletId || !incomeId) throw new Error("accounts were not created");
    const event = await pool.query<{ id: string }>(
      `INSERT INTO ledger_event (workspace_id, event_type, currency_code, status, occurred_on, published_at)
       VALUES ($1, 'opening.balance.v1', 'BRL', 'published', '2030-01-01', now()) RETURNING id`,
      [workspaceId],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("opening event was not created");
    await pool.query(
      `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor)
       VALUES ($1, $2, $3, 'BRL', 100), ($1, $2, $4, 'BRL', -100)`,
      [workspaceId, eventId, walletId, incomeId],
    );

    const goalService = new GoalService(pool, { cursorSecret: "integration-goal-secret" });
    const scope = {
      workspaceId,
      actorId,
      role: "owner" as const,
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    return {
      pool,
      workspaceId,
      goalService,
      scope,
      async close() {
        await pool?.end();
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await adminPool.end();
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    await adminPool.end();
    throw error;
  }
}
