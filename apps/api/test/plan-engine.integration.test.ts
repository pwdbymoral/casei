import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { fixedClock } from "@casei/domain";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { FinanceService } from "../src/finance-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("PLAN-003/004 finance engine PostgreSQL", () => {
  integrationIt(
    "preserves occurrence exceptions and settled history across series edits",
    async () => {
      const fixture = await createFixture("series");
      try {
        const service = new FinanceService(fixture.pool, {
          cursorSecret: "plan-engine-series-secret",
          clock: fixedClock(new Date("2030-01-01T12:00:00.000Z")),
        });
        const created = await service.createRecurrence(
          fixture.scope,
          {
            kind: "expense",
            amount: { currency: "BRL", minor: "100" },
            frequency: "monthly",
            startOn: "2030-01-01",
            variable: false,
            description: "Aluguel",
          },
          "plan-series-create-001",
        );
        const recurrenceId = created.response.id;
        await service.updateRecurrence(
          fixture.scope,
          recurrenceId,
          {
            scope: "this",
            effectiveOn: "2030-01-01",
            amount: { currency: "BRL", minor: "150" },
          },
          "plan-series-this-001",
          0,
        );
        await service.updateRecurrence(
          fixture.scope,
          recurrenceId,
          {
            scope: "this_and_future",
            effectiveOn: "2030-01-01",
            amount: { currency: "BRL", minor: "200" },
          },
          "plan-series-future-001",
          1,
        );
        const afterException = await fixture.pool.query<{
          occurred_on: string;
          amount_minor: string;
        }>(
          `SELECT occurred_on::text, amount_minor::text
           FROM finance_transaction
          WHERE workspace_id = $1 AND recurrence_id = $2
          ORDER BY occurred_on LIMIT 3`,
          [fixture.workspaceId, recurrenceId],
        );
        expect(afterException.rows.map((row) => [row.occurred_on, row.amount_minor])).toEqual([
          ["2030-01-01", "150"],
          ["2030-02-01", "200"],
          ["2030-03-01", "200"],
        ]);
        const second = await fixture.pool.query<{ id: string; version: number }>(
          `SELECT id, version FROM finance_transaction
          WHERE workspace_id = $1 AND recurrence_id = $2 AND occurred_on = '2030-02-01'`,
          [fixture.workspaceId, recurrenceId],
        );
        const posted = await service.postTransaction(
          fixture.scope,
          second.rows[0]?.id ?? "",
          "plan-series-post-001",
          second.rows[0]?.version ?? 0,
        );
        expect(posted.state).toBe("posted");
        await service.updateRecurrence(
          fixture.scope,
          recurrenceId,
          {
            scope: "future_unsettled",
            effectiveOn: "2030-01-01",
            amount: { currency: "BRL", minor: "300" },
          },
          "plan-series-unsettled-001",
          2,
        );
        const afterSettlement = await fixture.pool.query<{
          occurred_on: string;
          amount_minor: string;
          state: string;
        }>(
          `SELECT occurred_on::text, amount_minor::text, state
           FROM finance_transaction
          WHERE workspace_id = $1 AND recurrence_id = $2
            AND occurred_on IN ('2030-01-01', '2030-02-01', '2030-03-01')
          ORDER BY occurred_on`,
          [fixture.workspaceId, recurrenceId],
        );
        expect(afterSettlement.rows.map((row) => [row.amount_minor, row.state])).toEqual([
          ["150", "planned"],
          ["200", "posted"],
          ["300", "planned"],
        ]);
        const exceptionAudit = await fixture.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_event
          WHERE workspace_id = $1 AND action = 'recurrence.occurrence_exception'`,
          [fixture.workspaceId],
        );
        expect(exceptionAudit.rows[0]?.count).toBe("1");
      } finally {
        await fixture.close();
      }
    },
  );

  integrationIt(
    "previews exact installments, edits one with conservation, and cancels only future",
    async () => {
      const fixture = await createFixture("installments");
      try {
        const service = new FinanceService(fixture.pool, {
          cursorSecret: "plan-engine-installment-secret",
          clock: fixedClock(new Date("2030-01-01T12:00:00.000Z")),
        });
        const preview = await service.previewInstallmentPlan(fixture.scope, {
          total: { currency: "BRL", minor: "100" },
          count: 3,
          firstDueOn: "2030-01-31",
        });
        expect(preview.installments.map((part) => part.amount.minor)).toEqual(["34", "33", "33"]);
        const plan = await service.createInstallmentPlan(
          fixture.scope,
          {
            total: { currency: "BRL", minor: "100" },
            count: 3,
            firstDueOn: "2030-01-31",
            description: "Compra",
          },
          "plan-installment-create-001",
        );
        const edited = await service.updateInstallment(
          fixture.scope,
          plan.response.id,
          plan.response.installments[0]?.id ?? "",
          { amount: { currency: "BRL", minor: "40" } },
          "plan-installment-single-001",
          0,
        );
        expect(edited.plan.installments.map((part) => part.amount.minor)).toEqual([
          "40",
          "33",
          "27",
        ]);
        expect(
          edited.plan.installments.reduce((sum, part) => sum + BigInt(part.amount.minor), 0n),
        ).toBe(100n);

        const secondPlan = await service.createInstallmentPlan(
          fixture.scope,
          {
            total: { currency: "BRL", minor: "120" },
            count: 3,
            firstDueOn: "2030-01-31",
            description: "Compra parcelada",
          },
          "plan-installment-create-002",
        );
        const first = secondPlan.response.installments[0];
        if (!first) throw new Error("expected first installment");
        await service.postTransaction(
          fixture.scope,
          first.transactionId,
          "plan-installment-post-001",
          first.version,
        );
        const canceled = await service.cancelFutureInstallments(
          fixture.scope,
          secondPlan.response.id,
          "plan-installment-cancel-001",
          0,
        );
        expect(canceled.plan.installments.map((part) => part.state)).toEqual([
          "posted",
          "canceled",
          "canceled",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );
});

async function createFixture(label: string) {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_plan_${label}_${suffix}`;
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
      `INSERT INTO workspace (name) VALUES ($1) RETURNING id`,
      [`Casa ${label}`],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    const actorId = `plan-owner-${suffix}`;
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
