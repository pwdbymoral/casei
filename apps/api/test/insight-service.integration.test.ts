import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { InsightService } from "../src/insight-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("INSIGHT read model PostgreSQL reconstruction", () => {
  integrationIt("rebuilds safe spending without double-counting card purchases", async () => {
    const fixture = await createFixture();
    try {
      const insight = new InsightService(fixture.pool, {
        clock: () => new Date("2026-08-05T12:00:00.000Z"),
      });
      const safe = await insight.getSafeToSpend(fixture.scope, {
        asOf: "2026-08-05",
        horizonDays: 30,
      });

      expect(safe).toMatchObject({
        asOf: "2026-08-05",
        to: "2026-09-04",
        available: true,
        safe: { currency: "BRL", minor: "750" },
        gross: { currency: "BRL", minor: "750" },
        confidence: {
          level: "medium",
          reasons: ["saldo_sem_conferencia_recente", "recorrencia_variavel_sem_estimativa"],
        },
        breakdown: {
          balance: { currency: "BRL", minor: "1500" },
          plannedIncome: { currency: "BRL", minor: "100" },
          plannedOutflow: { currency: "BRL", minor: "550" },
          walletOutflow: { currency: "BRL", minor: "250" },
          cardBills: { currency: "BRL", minor: "300" },
          coveredReservations: { currency: "BRL", minor: "200" },
          reserved: { currency: "BRL", minor: "200" },
          uncoveredReservations: { currency: "BRL", minor: "0" },
          safetyMargin: { currency: "BRL", minor: "100" },
        },
      });

      const model = await insight.getFinancialReadModel(fixture.scope, {
        asOf: "2026-08-05",
        from: "2026-08-01",
        to: "2026-08-31",
      });
      expect(model.result).toEqual({
        income: { currency: "BRL", minor: "2000" },
        expense: { currency: "BRL", minor: "900" },
        transfer: { currency: "BRL", minor: "0" },
        adjustment: { currency: "BRL", minor: "0" },
      });
      expect(model.stock).toEqual({ missingCount: 1, lowCount: 1 });
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_insight_${suffix}`;
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
      `INSERT INTO workspace (name) VALUES ('Casa insights') RETURNING id`,
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) throw new Error("workspace was not created");
    const actorId = `insight-owner-${suffix}`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Owner', $2, true)`,
      [actorId, `${actorId}@example.test`],
    );
    await pool.query(
      `INSERT INTO workspace_preference (workspace_id, currency_code, timezone, safety_margin_minor)
       VALUES ($1, 'BRL', 'America/Fortaleza', 100)`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO membership (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [workspaceId, actorId],
    );

    const accounts = await pool.query<{
      wallet_id: string;
      income_id: string;
      expense_id: string;
      card_liability_id: string;
    }>(
      `WITH wallet AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'wallet', 'Carteira', 'BRL') RETURNING id
       ), income AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'income', 'Receitas', 'BRL') RETURNING id
       ), expense AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'expense', 'Despesas', 'BRL') RETURNING id
       ), card_liability AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'card_liability', 'Cartão', 'BRL') RETURNING id
       )
       SELECT wallet.id AS wallet_id, income.id AS income_id, expense.id AS expense_id,
              card_liability.id AS card_liability_id
         FROM wallet, income, expense, card_liability`,
      [workspaceId],
    );
    const account = accounts.rows[0];
    if (!account) throw new Error("accounts were not created");

    await insertLedgerEvent(pool, workspaceId, "opening.balance.v1", "2026-08-01", [
      [account.wallet_id, 2_000],
      [account.income_id, -2_000],
    ]);
    await insertLedgerEvent(pool, workspaceId, "transaction.posted.v1", "2026-08-02", [
      [account.wallet_id, -500],
      [account.expense_id, 500],
    ]);

    const card = await pool.query<{ id: string }>(
      `INSERT INTO credit_card (workspace_id, name, closing_day, due_day, currency_code)
       VALUES ($1, 'Cartão', 20, 15, 'BRL') RETURNING id`,
      [workspaceId],
    );
    const cardId = card.rows[0]?.id;
    if (!cardId) throw new Error("card was not created");
    const statement = await pool.query<{ id: string }>(
      `INSERT INTO credit_statement (workspace_id, card_id, period_start, closing_on, due_on, total_minor, paid_minor)
       VALUES ($1, $2, '2026-08-01', '2026-08-20', '2026-08-15', 300, 0) RETURNING id`,
      [workspaceId, cardId],
    );
    const statementId = statement.rows[0]?.id;
    if (!statementId) throw new Error("statement was not created");
    const cardTransaction = await pool.query<{ id: string }>(
      `INSERT INTO finance_transaction
         (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, posted_on, statement_id, card_id)
       VALUES ($1, 'expense', 'posted', 'card', 400, 400, 'BRL', '2026-08-03', now(), $2, $3)
       RETURNING id`,
      [workspaceId, statementId, cardId],
    );
    await insertLedgerEvent(
      pool,
      workspaceId,
      "transaction.posted.v1",
      "2026-08-03",
      [
        [account.expense_id, 400],
        [account.card_liability_id, -400],
      ],
      cardTransaction.rows[0]?.id,
    );

    await pool.query(
      `INSERT INTO recurrence_rule (workspace_id, frequency, interval, start_on, variable)
       VALUES ($1, 'monthly', 1, '2026-08-01', true) RETURNING id`,
      [workspaceId],
    );
    const recurrence = await pool.query<{ id: string }>(
      `SELECT id FROM recurrence_rule WHERE workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO finance_transaction
         (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, due_on, recurrence_id)
       VALUES ($1, 'expense', 'planned', 'wallet', 50, 0, 'BRL', '2026-08-04', '2026-08-10', $2),
              ($1, 'income', 'planned', 'wallet', 100, 0, 'BRL', '2026-08-04', '2026-08-09', NULL),
              ($1, 'expense', 'planned', 'wallet', 200, 0, 'BRL', '2026-08-04', '2026-08-11', NULL)`,
      [workspaceId, recurrence.rows[0]?.id],
    );

    const goal = await pool.query<{ id: string }>(
      `INSERT INTO goal (workspace_id, name, target_minor, currency_code) VALUES ($1, 'Reserva', 1000, 'BRL') RETURNING id`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO goal_reservation_movement (workspace_id, goal_id, kind, amount_minor, currency_code, occurred_on)
       VALUES ($1, $2, 'allocate', 250, 'BRL', '2026-08-04'), ($1, $2, 'release', 50, 'BRL', '2026-08-05')`,
      [workspaceId, goal.rows[0]?.id],
    );
    await pool.query(
      `INSERT INTO stock_product (workspace_id, name, name_normalized, marked_missing)
       VALUES ($1, 'Arroz', 'arroz', true)`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO stock_product (workspace_id, name, name_normalized, quantity_milli, minimum_milli)
       VALUES ($1, 'Feijão', 'feijao', 1, 2)`,
      [workspaceId],
    );

    return {
      pool,
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

async function insertLedgerEvent(
  pool: ReturnType<typeof getDatabasePool>,
  workspaceId: string,
  eventType: string,
  occurredOn: string,
  entries: readonly [accountId: string, amount: number][],
  transactionId?: string,
) {
  const event = await pool.query<{ id: string }>(
    `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at)
     VALUES ($1, $2, $3, 'BRL', 'published', $4, now()) RETURNING id`,
    [workspaceId, transactionId ?? null, eventType, occurredOn],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("ledger event was not created");
  for (const [accountId, amount] of entries) {
    await pool.query(
      `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor)
       VALUES ($1, $2, $3, 'BRL', $4)`,
      [workspaceId, eventId, accountId, amount],
    );
  }
}
