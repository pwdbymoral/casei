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
        safe: { currency: "BRL", minor: "725" },
        gross: { currency: "BRL", minor: "725" },
        confidence: {
          level: "medium",
          reasons: ["recorrencia_variavel_sem_estimativa"],
        },
        breakdown: {
          balance: { currency: "BRL", minor: "1700" },
          plannedIncome: { currency: "BRL", minor: "300" },
          plannedOutflow: { currency: "BRL", minor: "975" },
          walletOutflow: { currency: "BRL", minor: "275" },
          cardBills: { currency: "BRL", minor: "300" },
          loanReceivable: { currency: "BRL", minor: "200" },
          loanPayable: { currency: "BRL", minor: "400" },
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
      expect(model.commitments).toMatchObject({
        plannedIncome: { currency: "BRL", minor: "300" },
        plannedOutflow: { currency: "BRL", minor: "975" },
        overdueOutflow: { currency: "BRL", minor: "425" },
        loanReceivable: { currency: "BRL", minor: "200" },
        loanPayable: { currency: "BRL", minor: "400" },
      });
      expect(model.stock).toEqual({ missingCount: 2, lowCount: 2 });
    } finally {
      await fixture.close();
    }
  });

  integrationIt(
    "projects dated commitments with source decomposition and overdue items",
    async () => {
      const fixture = await createFixture();
      try {
        const projection = await new InsightService(fixture.pool).getProjection(fixture.scope, {
          asOf: "2026-08-05",
          months: 1,
        });

        expect(projection).toMatchObject({
          asOf: "2026-08-05",
          to: "2026-09-05",
          months: 1,
          startingBalance: { currency: "BRL", minor: "1700" },
          confidence: {
            level: "medium",
            reasons: ["evento_variavel_sem_estimativa"],
          },
        });
        expect(projection.points[0]).toMatchObject({
          date: "2026-09-05",
          balance: { currency: "BRL", minor: "1075" },
          delta: { currency: "BRL", minor: "-625" },
          unknownEventCount: 1,
        });
        expect(projection.points[0]?.events.map((event) => event.source.type)).toEqual([
          "transaction",
          "loan",
          "transaction",
          "recurrence",
          "transaction",
          "statement",
          "loan",
        ]);
        expect(
          projection.points[0]?.events.some((event) => event.source.type === "statement"),
        ).toBe(true);
      } finally {
        await fixture.close();
      }
    },
  );

  integrationIt(
    "reconciles monthly and category report rows with published transactions",
    async () => {
      const fixture = await createFixture();
      try {
        const report = await new InsightService(fixture.pool).getReport(fixture.scope, {
          asOf: "2026-08-31",
          from: "2026-08-01",
          to: "2026-08-31",
        });
        expect(report.totals).toEqual({
          income: { currency: "BRL", minor: "0" },
          expense: { currency: "BRL", minor: "400" },
          net: { currency: "BRL", minor: "-400" },
          transactionCount: 1,
        });
        expect(report.monthly).toEqual([
          {
            month: "2026-08",
            income: { currency: "BRL", minor: "0" },
            expense: { currency: "BRL", minor: "400" },
            net: { currency: "BRL", minor: "-400" },
            transactionCount: 1,
          },
        ]);
        expect(report.categories).toEqual([
          {
            categoryId: null,
            categoryName: "Sem categoria",
            income: { currency: "BRL", minor: "0" },
            expense: { currency: "BRL", minor: "400" },
            net: { currency: "BRL", minor: "-400" },
            transactionCount: 1,
          },
        ]);
        expect(report.reconciliation).toMatchObject({
          source: "published_ledger",
          transactionCount: 1,
          export: {
            domain: "transactions",
            format: "csv",
            from: "2026-08-01",
            to: "2026-08-31",
            kind: "all",
            categoryId: null,
          },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  integrationIt(
    "does not present safe spending without opening or reconciliation evidence",
    async () => {
      const fixture = await createFixture({ withOpening: false });
      try {
        const insight = new InsightService(fixture.pool);
        const safe = await insight.getSafeToSpend(fixture.scope, {
          asOf: "2026-08-05",
          horizonDays: 30,
        });

        expect(safe.available).toBe(false);
        expect(safe.safe).toBeNull();
        expect(safe.gross).toBeNull();
        expect(safe.confidence).toEqual({
          level: "low",
          reasons: ["saldo_sem_evidencia_de_abertura_ou_conferencia"],
        });
      } finally {
        await fixture.close();
      }
    },
  );
});

async function createFixture(options: { withOpening?: boolean } = {}) {
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
      loan_receivable_id: string;
      loan_payable_id: string;
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
       ), loan_receivable AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'loan_receivable', 'Empréstimos a receber', 'BRL') RETURNING id
       ), loan_payable AS (
         INSERT INTO financial_account (workspace_id, kind, name, currency_code)
         VALUES ($1, 'loan_payable', 'Empréstimos a pagar', 'BRL') RETURNING id
       )
       SELECT wallet.id AS wallet_id, income.id AS income_id, expense.id AS expense_id,
              card_liability.id AS card_liability_id,
              loan_receivable.id AS loan_receivable_id,
              loan_payable.id AS loan_payable_id
         FROM wallet, income, expense, card_liability, loan_receivable, loan_payable`,
      [workspaceId],
    );
    const account = accounts.rows[0];
    if (!account) throw new Error("accounts were not created");

    if (options.withOpening !== false) {
      await insertLedgerEvent(pool, workspaceId, "opening.balance.v1", "2026-08-01", [
        [account.wallet_id, 2_000],
        [account.income_id, -2_000],
      ]);
    }
    await insertLedgerEvent(pool, workspaceId, "transaction.posted.v1", "2026-08-02", [
      [account.wallet_id, -500],
      [account.expense_id, 500],
    ]);
    const lentPrincipalEventId = await insertLedgerEvent(
      pool,
      workspaceId,
      "loan.principal.lent.v1",
      "2026-08-01",
      [
        [account.wallet_id, -300],
        [account.loan_receivable_id, 300],
      ],
    );
    const borrowedPrincipalEventId = await insertLedgerEvent(
      pool,
      workspaceId,
      "loan.principal.borrowed.v1",
      "2026-08-01",
      [
        [account.wallet_id, 500],
        [account.loan_payable_id, -500],
      ],
    );
    const lentPaymentEventId = await insertLedgerEvent(
      pool,
      workspaceId,
      "loan.payment.received.v1",
      "2026-08-04",
      [
        [account.wallet_id, 100],
        [account.loan_receivable_id, -100],
      ],
    );
    const futureLentPaymentEventId = await insertLedgerEvent(
      pool,
      workspaceId,
      "loan.payment.received.v1",
      "2026-08-10",
      [
        [account.wallet_id, 50],
        [account.loan_receivable_id, -50],
      ],
    );
    const borrowedPaymentEventId = await insertLedgerEvent(
      pool,
      workspaceId,
      "loan.payment.made.v1",
      "2026-08-04",
      [
        [account.wallet_id, -100],
        [account.loan_payable_id, 100],
      ],
    );
    const loans = await pool.query<{ id: string; direction: "lent" | "borrowed" }>(
      `INSERT INTO loan_contract
         (workspace_id, direction, counterparty, principal_minor, paid_minor, currency_code,
          occurred_on, due_on, principal_event_id, status, version)
       VALUES
         ($1, 'lent', 'Ana', 300, 150, 'BRL', '2026-08-01', '2026-08-20', $2, 'open', 1),
         ($1, 'borrowed', 'Banco doméstico', 500, 100, 'BRL', '2026-08-01', '2026-08-03', $3, 'open', 1)
       RETURNING id, direction`,
      [workspaceId, lentPrincipalEventId, borrowedPrincipalEventId],
    );
    const lentLoanId = loans.rows.find((row) => row.direction === "lent")?.id;
    const borrowedLoanId = loans.rows.find((row) => row.direction === "borrowed")?.id;
    if (!lentLoanId || !borrowedLoanId) throw new Error("loans were not created");
    await pool.query(
      `INSERT INTO loan_payment
         (workspace_id, loan_id, amount_minor, currency_code, occurred_on, ledger_event_id)
       VALUES ($1, $2, 100, 'BRL', '2026-08-04', $3),
              ($1, $4, 100, 'BRL', '2026-08-04', $5),
              ($1, $2, 50, 'BRL', '2026-08-10', $6)`,
      [
        workspaceId,
        lentLoanId,
        lentPaymentEventId,
        borrowedLoanId,
        borrowedPaymentEventId,
        futureLentPaymentEventId,
      ],
    );

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
      `INSERT INTO recurrence_rule
         (workspace_id, kind, amount_minor, frequency, interval, start_on, variable)
       VALUES ($1, 'expense', 50, 'monthly', 1, '2026-08-01', true) RETURNING id`,
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
              ($1, 'expense', 'planned', 'wallet', 200, 0, 'BRL', '2026-08-04', '2026-08-11', NULL),
              ($1, 'expense', 'planned', 'wallet', 25, 0, 'BRL', '2026-07-31', '2026-08-01', NULL)`,
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
    await pool.query(
      `INSERT INTO stock_product (workspace_id, name, name_normalized, quantity_milli, minimum_milli)
       VALUES ($1, 'Leite zero', 'leite-zero', 0, 3), ($1, 'Sal', 'sal', 2, 2)`,
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await client.query<{ id: string }>(
      `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on)
       VALUES ($1, $2, $3, 'BRL', 'draft', $4) RETURNING id`,
      [workspaceId, transactionId ?? null, eventType, occurredOn],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("ledger event was not created");
    for (const [accountId, amount] of entries) {
      await client.query(
        `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor)
         VALUES ($1, $2, $3, 'BRL', $4)`,
        [workspaceId, eventId, accountId, amount],
      );
    }
    await client.query(
      `UPDATE ledger_event SET status = 'published', published_at = now() WHERE id = $1`,
      [eventId],
    );
    await client.query("COMMIT");
    return eventId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
