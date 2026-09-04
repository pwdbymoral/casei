import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, ensureApplicationRole, getDatabasePool } from "@casei/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

import { FinanceService } from "../src/finance-service.js";
import { IdentityService } from "../src/identity-service.js";

const adminUrl = process.env.DATABASE_URL_TEST;
const integrationIt = adminUrl ? it : it.skip;

describe("FIN-002 wallet PostgreSQL", () => {
  integrationIt(
    "blocks currency changes after zero-balance onboarding creates the wallet",
    async () => {
      const fixture = await createFixture();
      try {
        const identity = new IdentityService(fixture.pool);
        const onboarding = await identity.createOnboarding(
          { userId: fixture.actorId, email: fixture.email },
          {
            displayName: "Owner zero",
            workspaceName: "Casa carteira zero",
            currency: "BRL",
            timeZone: "America/Fortaleza",
            includeInitialBalance: false,
            initialBalanceMinor: "0",
          },
          "wallet-onboarding-zero-001",
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        );
        const scope = {
          workspaceId: onboarding.workspace.id,
          actorId: fixture.actorId,
          role: "owner" as const,
          correlationId: "01ARZ3NDEKTSV4RRQ69G5FB0",
        };
        const identityScope = {
          workspaceId: onboarding.workspace.id,
          actor: { userId: fixture.actorId, email: fixture.email },
          role: "owner" as const,
          correlationId: "01ARZ3NDEKTSV4RRQ69G5FB0",
        };
        const finance = new FinanceService(fixture.pool, { cursorSecret: "wallet-zero-secret" });
        await expect(finance.getWallet(scope)).resolves.toMatchObject({
          balance: { currency: "BRL", minor: "0" },
        });
        const preferences = await identity.getWorkspacePreferences(identityScope);
        await expect(
          identity.updateWorkspacePreferences(
            identityScope,
            {
              name: "Casa carteira zero",
              currency: "USD",
              timeZone: "America/Fortaleza",
              safetyMarginMinor: "0",
            },
            preferences.version,
          ),
        ).rejects.toMatchObject({ name: "IdentityConflictError" });
      } finally {
        await fixture.close();
      }
    },
  );

  integrationIt(
    "materializes onboarding immediately and serializes concurrent reconciliations",
    async () => {
      const fixture = await createFixture();
      try {
        const identity = new IdentityService(fixture.pool, {
          now: () => new Date("2030-01-10T12:00:00.000Z"),
        });
        const onboarding = await identity.createOnboarding(
          { userId: fixture.actorId, email: fixture.email },
          {
            displayName: "Owner",
            workspaceName: "Casa carteira",
            currency: "BRL",
            timeZone: "America/Fortaleza",
            includeInitialBalance: true,
            initialBalanceMinor: "1000",
          },
          "wallet-onboarding-integration-001",
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        );
        const scope = {
          workspaceId: onboarding.workspace.id,
          actorId: fixture.actorId,
          role: "owner" as const,
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        };
        const identityScope = {
          workspaceId: onboarding.workspace.id,
          actor: { userId: fixture.actorId, email: fixture.email },
          role: "owner" as const,
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        };
        const finance = new FinanceService(fixture.pool, {
          cursorSecret: "wallet-integration-secret",
          clock: { now: () => new Date("2030-01-10T12:00:00.000Z") },
        });

        const wallet = await finance.getWallet(scope);
        expect(wallet).toEqual({
          workspaceId: onboarding.workspace.id,
          balance: { currency: "BRL", minor: "1000" },
          version: 1,
        });
        const opening = await fixture.pool.query<{
          event_type: string;
          transaction_count: string;
        }>(
          `SELECT e.event_type, count(DISTINCT t.id)::text AS transaction_count
             FROM ledger_event e
             JOIN finance_transaction t
               ON t.workspace_id = e.workspace_id AND t.id = e.transaction_id
            WHERE e.workspace_id = $1
            GROUP BY e.event_type`,
          [onboarding.workspace.id],
        );
        expect(opening.rows).toEqual([
          { event_type: "wallet.opening_balance.v1", transaction_count: "1" },
        ]);

        const preferences = await identity.getWorkspacePreferences(identityScope);
        await expect(
          identity.updateWorkspacePreferences(
            identityScope,
            {
              name: "Casa carteira",
              currency: "USD",
              timeZone: "America/Fortaleza",
              safetyMarginMinor: "0",
            },
            preferences.version,
          ),
        ).rejects.toMatchObject({ name: "IdentityConflictError" });

        const preview = await finance.previewWalletAdjustment(scope, {
          observedBalance: { currency: "BRL", minor: "750" },
        });
        expect(preview).toMatchObject({
          wallet: { balance: { minor: "1000" }, version: 1 },
          difference: { minor: "-250" },
        });

        const attempts = await Promise.allSettled([
          finance.adjustWallet(
            scope,
            {
              observedBalance: { currency: "BRL", minor: "750" },
              reason: "Contagem A",
            },
            "wallet-adjust-integration-a",
            preview.wallet.version,
          ),
          finance.adjustWallet(
            scope,
            {
              observedBalance: { currency: "BRL", minor: "800" },
              reason: "Contagem B",
            },
            "wallet-adjust-integration-b",
            preview.wallet.version,
          ),
        ]);
        const fulfilled = attempts.filter(
          (
            attempt,
          ): attempt is PromiseFulfilledResult<
            Awaited<ReturnType<FinanceService["adjustWallet"]>>
          > => attempt.status === "fulfilled",
        );
        const rejected = attempts.filter(
          (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({ code: "version_conflict" });
        expect(fulfilled[0]?.value.adjustment.wallet.version).toBe(2);

        const winner = fulfilled[0]?.value;
        if (!winner) throw new Error("one adjustment should win");
        const replay = await finance.adjustWallet(
          scope,
          {
            observedBalance: winner.adjustment.observedBalance,
            reason: winner.adjustment.observedBalance.minor === "750" ? "Contagem A" : "Contagem B",
          },
          winner.adjustment.observedBalance.minor === "750"
            ? "wallet-adjust-integration-a"
            : "wallet-adjust-integration-b",
          preview.wallet.version,
        );
        expect(replay.replayed).toBe(true);
        expect(replay.adjustment).toEqual(winner.adjustment);

        const current = await finance.getWallet(scope);
        expect(current.balance).toEqual(winner.adjustment.observedBalance);
        expect(current.version).toBe(2);
        const effects = await fixture.pool.query<{
          event_type: string;
          kinds: string[];
          total: string;
        }>(
          `SELECT event.event_type,
                  array_agg(account.kind ORDER BY account.kind) AS kinds,
                  sum(entry.amount_minor)::text AS total
             FROM ledger_event event
             JOIN ledger_entry entry
               ON entry.workspace_id = event.workspace_id AND entry.event_id = event.id
             JOIN financial_account account
               ON account.workspace_id = entry.workspace_id AND account.id = entry.account_id
            WHERE event.workspace_id = $1 AND event.event_type LIKE 'wallet.%'
            GROUP BY event.id, event.event_type
            ORDER BY event.created_at`,
          [onboarding.workspace.id],
        );
        expect(effects.rows).toHaveLength(2);
        expect(effects.rows.every((event) => event.total === "0")).toBe(true);
        expect(effects.rows.flatMap((event) => event.kinds)).not.toContain("income");
        expect(effects.rows.flatMap((event) => event.kinds)).not.toContain("expense");
        expect(effects.rows.at(-1)?.kinds).toEqual(["adjustment", "wallet"]);
        const audit = await fixture.pool.query<{
          reason: string;
          target_type: string;
          before_redacted: Record<string, unknown>;
          after_redacted: Record<string, unknown>;
        }>(
          `SELECT reason, target_type, before_redacted, after_redacted FROM audit_event
            WHERE workspace_id = $1 AND action = 'wallet.adjusted'`,
          [onboarding.workspace.id],
        );
        expect(audit.rows).toEqual([
          {
            reason: winner.adjustment.observedBalance.minor === "750" ? "Contagem A" : "Contagem B",
            target_type: "finance_transaction",
            before_redacted: {
              kind: "adjustment",
              state: "posted",
              version: 0,
              walletVersion: 1,
            },
            after_redacted: {
              kind: "adjustment",
              state: "posted",
              version: 0,
              walletVersion: 2,
            },
          },
        ]);
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("CARD-003 statement adjustment PostgreSQL", () => {
  integrationIt(
    "serializes concurrent partial refunds and rejects adjustment chaining/reversal",
    async () => {
      const fixture = await createFixture();
      try {
        const identity = new IdentityService(fixture.pool);
        const onboarding = await identity.createOnboarding(
          { userId: fixture.actorId, email: fixture.email },
          {
            displayName: "Card owner",
            workspaceName: "Casa cartão",
            currency: "BRL",
            timeZone: "America/Fortaleza",
            includeInitialBalance: false,
            initialBalanceMinor: "0",
          },
          "card-onboarding-integration-001",
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        );
        const scope = {
          workspaceId: onboarding.workspace.id,
          actorId: fixture.actorId,
          role: "owner" as const,
          correlationId: "01ARZ3NDEKTSV4RRQ69G5FB0",
        };
        const finance = new FinanceService(fixture.pool, {
          cursorSecret: "card-integration-secret",
          clock: { now: () => new Date("2030-01-10T12:00:00.000Z") },
        });
        const cardResult = await finance.createCard(
          scope,
          { name: "Cartão principal", closingDay: 10, dueDay: 17 },
          "card-create-integration-001",
        );
        const card = cardResult.response as unknown as { id: string };
        const purchase = await finance.createCardPurchase(
          scope,
          {
            amount: { currency: "BRL", minor: "1000" },
            occurredOn: "2030-01-05",
            description: "Compra original",
            cardId: card.id,
          },
          "card-purchase-integration-001",
        );
        expect(purchase.transaction.occurredOn).toBe("2030-01-05");
        const firstStatement = (await finance.listStatements(scope, card.id))[0];
        expect(firstStatement).toBeTruthy();
        if (!firstStatement) throw new Error("expected an open statement");
        await finance.createCardPurchase(
          scope,
          {
            amount: { currency: "BRL", minor: "1000" },
            occurredOn: "2030-01-11",
            description: "Compra de outro ciclo",
            cardId: card.id,
          },
          "card-purchase-integration-002",
        );
        const secondStatement = (await finance.listStatements(scope, card.id)).find(
          (candidate) => candidate.id !== firstStatement.id,
        );
        expect(secondStatement).toBeTruthy();
        if (!secondStatement) throw new Error("expected a second open statement");

        const attempts = await Promise.allSettled([
          finance.createStatementRefund(
            scope,
            firstStatement.id,
            {
              sourceTransactionId: purchase.transaction.id,
              amount: { currency: "BRL", minor: "700" },
            },
            "card-refund-integration-a",
            firstStatement.version,
          ),
          finance.createStatementRefund(
            scope,
            secondStatement.id,
            {
              sourceTransactionId: purchase.transaction.id,
              amount: { currency: "BRL", minor: "700" },
            },
            "card-refund-integration-b",
            secondStatement.version,
          ),
        ]);
        const fulfilled = attempts.filter(
          (
            attempt,
          ): attempt is PromiseFulfilledResult<
            Awaited<ReturnType<FinanceService["createStatementRefund"]>>
          > => attempt.status === "fulfilled",
        );
        const rejected = attempts.filter(
          (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
          code: "conflict",
          message: "O estorno excede o saldo ainda não estornado da compra.",
        });
        const winner = fulfilled[0]?.value;
        if (!winner) throw new Error("one refund should win");
        const refunds = await fixture.pool.query<{ count: string; total: string }>(
          `SELECT count(*)::text AS count, COALESCE(SUM(-amount_minor), 0)::text AS total
             FROM card_statement_adjustment
            WHERE workspace_id = $1 AND source_transaction_id = $2 AND kind = 'refund'`,
          [scope.workspaceId, purchase.transaction.id],
        );
        expect(refunds.rows).toEqual([{ count: "1", total: "700" }]);

        await expect(
          finance.createStatementRefund(
            scope,
            winner.response.statement.id,
            {
              sourceTransactionId: winner.response.transaction.id,
              amount: { currency: "BRL", minor: "10" },
            },
            "card-refund-from-refund-integration-001",
            winner.response.statement.version,
          ),
        ).rejects.toMatchObject({
          code: "conflict",
          message: "O estorno precisa apontar para uma compra realizada deste cartão.",
        });
        await expect(
          finance.reverseTransaction(
            scope,
            winner.response.transaction.id,
            "card-reverse-adjustment-integration-001",
            winner.response.transaction.version,
          ),
        ).rejects.toMatchObject({
          code: "conflict",
          message:
            "Este lançamento é um ajuste da fatura; abra a fatura e registre a correção correspondente.",
        });
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("CARD-004 statement payment PostgreSQL", () => {
  integrationIt("separates confirmed excess credit and reverses it atomically", async () => {
    const fixture = await createFixture();
    try {
      const identity = new IdentityService(fixture.pool);
      const onboarding = await identity.createOnboarding(
        { userId: fixture.actorId, email: fixture.email },
        {
          displayName: "Card payment owner",
          workspaceName: "Casa pagamento",
          currency: "BRL",
          timeZone: "America/Fortaleza",
          includeInitialBalance: false,
          initialBalanceMinor: "0",
        },
        "card-payment-onboarding-001",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      const scope = {
        workspaceId: onboarding.workspace.id,
        actorId: fixture.actorId,
        role: "owner" as const,
        correlationId: "01ARZ3NDEKTSV4RRQ69G5FB0",
      };
      const finance = new FinanceService(fixture.pool, { cursorSecret: "card-payment-secret" });
      const card = await finance.createCard(
        scope,
        { name: "Cartão principal", closingDay: 10, dueDay: 17 },
        "card-payment-card-001",
      );
      const cardId = (card.response as { id: string }).id;
      const purchase = await finance.createCardPurchase(
        scope,
        {
          amount: { currency: "BRL", minor: "1000" },
          occurredOn: "2030-01-05",
          description: "Compra",
          cardId,
        },
        "card-payment-purchase-001",
      );
      const statement = (await finance.listStatements(scope, cardId))[0];
      if (!statement) throw new Error("expected statement");
      const payment = await finance.payStatement(
        scope,
        statement.id,
        {
          amount: { currency: "BRL", minor: "1500" },
          allowCredit: true,
          occurredOn: "2030-01-10",
        },
        "card-payment-pay-001",
      );
      expect(payment.response).toMatchObject({
        amount: { currency: "BRL", minor: "1500" },
        applied: { currency: "BRL", minor: "1000" },
        credit: { currency: "BRL", minor: "500" },
      });
      const afterPayment = await finance.getStatement(scope, statement.id);
      expect(afterPayment?.paid.minor).toBe("1000");
      expect(afterPayment?.openAmount.minor).toBe("0");
      const credit = await fixture.pool.query<{ amount_minor: string; state: string }>(
        `SELECT amount_minor, state FROM card_credit WHERE workspace_id = $1`,
        [scope.workspaceId],
      );
      expect(credit.rows).toEqual([{ amount_minor: "500", state: "active" }]);

      const transaction = await finance.getTransaction(scope, payment.response.transactionId);
      if (!transaction) throw new Error("expected payment transaction");
      await finance.reverseTransaction(
        scope,
        payment.response.transactionId,
        "card-payment-cancel-001",
        transaction.version,
        statement.id,
      );
      const afterCancel = await finance.getStatement(scope, statement.id);
      expect(afterCancel?.paid.minor).toBe("0");
      expect(afterCancel?.openAmount.minor).toBe("1000");
      const canceledCredit = await fixture.pool.query<{ state: string }>(
        `SELECT state FROM card_credit WHERE workspace_id = $1`,
        [scope.workspaceId],
      );
      expect(canceledCredit.rows).toEqual([{ state: "canceled" }]);
      const audit = await fixture.pool.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE workspace_id = $1 AND target_id = $2 ORDER BY occurred_at`,
        [scope.workspaceId, payment.response.transactionId],
      );
      expect(audit.rows.map((row) => row.action)).toContain("transaction.reversed");
      const statementAudit = await fixture.pool.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE workspace_id = $1 AND target_id = $2`,
        [scope.workspaceId, statement.id],
      );
      expect(statementAudit.rows.map((row) => row.action)).toContain("statement.payment_reversed");
      expect(purchase.transaction.cardId).toBe(cardId);
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  if (!adminUrl) throw new Error("DATABASE_URL_TEST is required");
  const adminPool = getDatabasePool({ connectionString: adminUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `casei_wallet_${suffix}`;
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
    const actorId = `wallet-owner-${suffix}`;
    const email = `${actorId}@example.test`;
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, 'Owner', $2, true)`,
      [actorId, email],
    );
    return {
      pool,
      actorId,
      email,
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
