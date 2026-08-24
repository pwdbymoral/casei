import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { fixedClock } from "@casei/domain";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { FinanceService } from "../src/finance-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("PLAN-002 recurrence PostgreSQL", () => {
  integrationIt("expands a civil twelve-month window idempotently and honors pause", async () => {
    const fixture = await createFixture();
    try {
      const firstClock = fixedClock(new Date("2030-01-15T12:00:00.000Z"));
      const service = new FinanceService(fixture.pool, {
        cursorSecret: "recurrence-integration-secret",
        clock: firstClock,
      });
      const created = await service.createRecurrence(
        fixture.scope,
        {
          kind: "expense",
          amount: { currency: "BRL", minor: "100" },
          frequency: "monthly",
          startOn: "2030-01-31",
          variable: false,
          description: "Aluguel",
        },
        "recurrence-create-integration-001",
      );
      expect(created.replayed).toBe(false);
      expect(created.response.occurrences).toHaveLength(12);
      expect(created.response.occurrences.at(-1)).toBe("2030-12-31");

      const worker = service.createRecurrenceWorker();
      const [firstRun, concurrentRun] = await Promise.all([
        worker.runOnce(fixture.workspaceId, new Date("2030-01-15T12:00:00.000Z")),
        worker.runOnce(fixture.workspaceId, new Date("2030-01-15T12:00:00.000Z")),
      ]);
      expect([firstRun.state, concurrentRun.state].sort()).toEqual(["idle", "succeeded"]);
      const retryRun = await worker.runOnce(
        fixture.workspaceId,
        new Date("2030-01-15T12:00:00.000Z"),
      );
      expect(retryRun.state).toBe("idle");

      const initialCount = await fixture.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM recurrence_occurrence WHERE recurrence_id = $1`,
        [created.response.id],
      );
      expect(initialCount.rows[0]?.count).toBe("12");

      const paused = await service.transitionRecurrence(
        fixture.scope,
        created.response.id,
        "pause",
        { effectiveOn: "2030-02-15" },
        "recurrence-pause-integration-001",
        0,
      );
      expect(paused.recurrence.pausedOn).toBe("2030-02-15");
      expect(paused.recurrence.version).toBe(1);

      const nextService = new FinanceService(fixture.pool, {
        cursorSecret: "recurrence-integration-secret",
        clock: fixedClock(new Date("2030-02-16T12:00:00.000Z")),
      });
      await nextService.scheduleRecurrenceExpansions(new Date("2030-02-16T12:00:00.000Z"));
      const nextRun = await nextService
        .createRecurrenceWorker()
        .runOnce(fixture.workspaceId, new Date("2030-02-16T12:00:00.000Z"));
      expect(nextRun.state).toBe("succeeded");
      const pausedCount = await fixture.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM recurrence_occurrence WHERE recurrence_id = $1`,
        [created.response.id],
      );
      expect(pausedCount.rows[0]?.count).toBe("12");
      const canceled = await fixture.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM finance_transaction
          WHERE recurrence_id = $1 AND state = 'canceled'`,
        [created.response.id],
      );
      expect(canceled.rows[0]?.count).toBe("11");
    } finally {
      await fixture.close();
    }
  });

  integrationIt("discovers legacy active rules even when no expansion job exists", async () => {
    const fixture = await createFixture();
    try {
      const recurrence = await fixture.pool.query<{ id: string }>(
        `INSERT INTO recurrence_rule
          (workspace_id, kind, amount_minor, frequency, interval, start_on, variable, description)
         VALUES ($1, 'expense', 125, 'monthly', 1, '2030-01-31', false, 'Regra legada')
         RETURNING id`,
        [fixture.workspaceId],
      );
      const recurrenceId = recurrence.rows[0]?.id;
      expect(recurrenceId).toBeTruthy();

      const service = new FinanceService(fixture.pool, {
        cursorSecret: "recurrence-discovery-secret",
        clock: fixedClock(new Date("2030-01-15T12:00:00.000Z")),
      });
      const scheduled = await service.scheduleRecurrenceExpansions(
        new Date("2030-01-15T12:00:00.000Z"),
      );
      expect(scheduled).toBe(1);

      const queued = await fixture.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM job
          WHERE workspace_id = $1
            AND job_type = 'recurrence.expand'`,
        [fixture.workspaceId],
      );
      expect(queued.rows[0]?.count).toBe("1");
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_recurrence_${suffix}`;
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
      `INSERT INTO workspace (name) VALUES ('Casa recorrência') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    const actorId = `recurrence-owner-${suffix}`;
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
    return {
      pool,
      workspaceId,
      scope: {
        workspaceId,
        actorId,
        role: "owner" as const,
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
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
