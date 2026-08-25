import {
  type CreateTransactionInput,
  categoryTransitionSchema,
  createCategorySchema,
  createCreditCardSchema,
  createInstallmentPlanSchema,
  createLoanSchema,
  createRecurrenceSchema,
  createTransactionSchema,
  domainIdSchema,
  loanPaymentSchema,
  recurrenceTransitionSchema,
  settleTransactionSchema,
  type TransactionListQuery,
  updateCategorySchema,
  updateCreditCardSchema,
  updateTransactionSchema,
  walletAdjustmentInputSchema,
  walletAdjustmentPreviewInputSchema,
} from "@casei/contracts";
import type { PoolClient as PgPoolClient, Pool } from "@casei/database";
import {
  executeIdempotent,
  type JobRecord,
  type JsonValue,
  PostgresJobWorker,
  withUnitOfWork,
} from "@casei/database";
import {
  addLocalDateDays,
  addLocalDateMonths,
  assertBalancedLedgerEvent,
  type Clock,
  calculateStatementDates,
  canonicalCardPaymentPostings,
  canonicalLoanPaymentPostings,
  canonicalLoanPrincipalPostings,
  canonicalTransactionPostings,
  canonicalWalletAdjustmentPostings,
  distributeInstallments,
  fixedClock,
  generateRecurrenceDates,
  generateRecurrenceDatesUntil,
  Money,
  parseLocalDate,
  parseTimeZone,
  systemClock,
  todayInTimeZone,
} from "@casei/domain";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./http/cursor.js";

export interface FinanceScope {
  workspaceId: string;
  actorId: string;
  correlationId: string;
  /** Membership role resolved by the authenticated HTTP boundary. */
  role: "owner" | "member" | "viewer";
}

export interface FinanceServiceOptions {
  /** Non-login PostgreSQL role used for all request data operations. */
  applicationRole?: string;
  /** Secret used to sign private list cursors. */
  cursorSecret?: string;
  /** Clock used for civil defaults and deterministic recurrence jobs. */
  clock?: Clock;
}

export interface TransactionView {
  id: string;
  workspaceId: string;
  kind: string;
  state: string;
  amount: { currency: string; minor: string };
  settledAmount: { currency: string; minor: string };
  occurredOn: string;
  dueOn: string | null;
  postedOn: string | null;
  description: string;
  categoryId: string | null;
  cardId: string | null;
  statementId: string | null;
  version: number;
}

export interface WalletView {
  workspaceId: string;
  balance: { currency: string; minor: string };
  version: number;
}

export interface WalletAdjustmentPreviewView {
  wallet: WalletView;
  observedBalance: { currency: string; minor: string };
  difference: { currency: string; minor: string };
}

export interface WalletAdjustmentResultView extends WalletAdjustmentPreviewView {
  transaction: TransactionView;
}

export interface LoanView {
  id: string;
  workspaceId: string;
  direction: "lent" | "borrowed";
  counterparty: string;
  principal: { currency: string; minor: string };
  paid: { currency: string; minor: string };
  remaining: { currency: string; minor: string };
  occurredOn: string;
  dueOn: string | null;
  status: "open" | "settled";
  version: number;
}

export interface LoanPaymentView {
  id: string;
  loanId: string;
  amount: { currency: string; minor: string };
  occurredOn: string;
}

export interface LoanPaymentResponse {
  loan: LoanView;
  payment: LoanPaymentView;
}

export interface CategoryView {
  id: string;
  workspaceId: string;
  name: string;
  kind: "income" | "expense" | "both";
  archived: boolean;
  version: number;
}

export interface CreditCardView {
  id: string;
  workspaceId: string;
  name: string;
  closingDay: number;
  dueDay: number;
  holder: string | null;
  lastFour: string | null;
  limit: { currency: string; minor: string } | null;
  archived: boolean;
  version: number;
}

export interface StatementView {
  id: string;
  workspaceId: string;
  cardId: string;
  periodStart: string;
  closingOn: string;
  dueOn: string;
  state: "open" | "closed" | "partially_paid" | "paid" | "canceled";
  total: { currency: string; minor: string };
  paid: { currency: string; minor: string };
  openAmount: { currency: string; minor: string };
  version: number;
}

export interface RecurrenceView {
  id: string;
  workspaceId: string;
  kind: "income" | "expense";
  amount: { currency: string; minor: string };
  frequency: "weekly" | "monthly" | "annual";
  interval: number;
  startOn: string;
  endOn: string | null;
  maxOccurrences: number | null;
  variable: boolean;
  estimatedAmount: { currency: string; minor: string } | null;
  description: string;
  pausedOn: string | null;
  version: number;
}

export interface RecurrenceCreateResponse {
  id: string;
  frequency: RecurrenceView["frequency"];
  occurrences: string[];
}

interface RecurrenceRuleRow {
  id: string;
  workspace_id: string;
  kind: "income" | "expense";
  amount_minor: string;
  frequency: "weekly" | "monthly" | "annual";
  interval: number;
  start_on: string;
  end_on: string | null;
  max_occurrences: number | null;
  variable: boolean;
  estimated_minor: string | null;
  description: string;
  status: "active" | "archived";
  paused_on: string | null;
  version: number;
}

interface RecurrenceJobPayload {
  workspaceId: string;
  asOf: string;
}

export interface StatementItemView {
  id: string;
  transactionId: string;
  statementId: string;
  type: "purchase" | "payment";
  state: "planned" | "partially_settled" | "posted" | "canceled";
  description: string;
  occurredOn: string;
  amount: { currency: string; minor: string };
}

export interface StatementItemsPage {
  items: StatementItemView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FinanceAuditEventView {
  id: string;
  transactionId: string;
  category: string;
  action: string;
  actorId: string | null;
  occurredAt: string;
  origin: string;
  correlationId: string;
  result: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface FinanceAuditLedgerEventView {
  id: string;
  eventType: string;
  status: string;
  occurredOn: string;
  publishedAt: string | null;
  reversedEventId: string | null;
}

export interface FinanceAuditDetailView extends FinanceAuditEventView {
  consequences: { ledgerEvents: FinanceAuditLedgerEventView[] };
}

export interface FinanceAuditPage {
  items: FinanceAuditEventView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SettlementCalculationInput {
  plannedMinor: bigint;
  settledMinor: bigint;
  effectiveMinor?: bigint;
}

export interface SettlementCalculation {
  amountMinor: bigint;
  settledMinor: bigint;
  state: "partially_settled" | "posted";
}

/** Variable recurrence occurrences need an explicit effective amount to settle. */
export function assertVariableRecurrenceSettlementAllowed(
  variable: boolean,
  hasEffectiveAmount: boolean,
): void {
  if (variable && !hasEffectiveAmount) {
    throw new FinanceConflictError(
      "Uma ocorrência variável exige confirmar o valor efetivo antes da liquidação.",
    );
  }
}

/** Calculates one non-overlapping settlement delta before touching the ledger. */
export function calculateSettlement({
  plannedMinor,
  settledMinor,
  effectiveMinor,
}: SettlementCalculationInput): SettlementCalculation {
  const remaining = plannedMinor - settledMinor;
  const amountMinor = effectiveMinor ?? remaining;
  if (plannedMinor <= 0n || settledMinor < 0n || settledMinor > plannedMinor) {
    throw new FinanceConflictError("O compromisso possui um saldo inválido.");
  }
  if (amountMinor <= 0n) {
    throw new FinanceConflictError("A liquidação deve ser maior que zero.");
  }
  if (amountMinor > remaining) {
    throw new FinanceConflictError("A liquidação excede o valor ainda em aberto.");
  }
  const nextSettledMinor = settledMinor + amountMinor;
  return {
    amountMinor,
    settledMinor: nextSettledMinor,
    state: nextSettledMinor === plannedMinor ? "posted" : "partially_settled",
  };
}

/** Canonical signed delta from the ledger balance to what the user observed. */
export function calculateWalletAdjustment(calculatedMinor: bigint, observedMinor: bigint): bigint {
  return observedMinor - calculatedMinor;
}
type StatementItemsCursorPosition = [occurredOn: string, createdAt: string, id: string];
const statementItemsCursorOrdering = "occurred_on,created_at,id";
type TransactionCursorPosition = [occurredOn: string, createdAt: string, id: string];
const transactionCursorOrdering = "occurred_on,created_at,id:desc";
type FinanceAuditCursorPosition = [occurredAt: string, id: string];
const financeAuditCursorOrdering = "occurred_at,id:desc";

interface TransactionRow {
  id: string;
  workspace_id: string;
  kind: string;
  state: string;
  amount_minor: string | bigint;
  settled_minor: string | bigint;
  currency_code: string;
  occurred_on: string;
  due_on: string | null;
  posted_on: Date | string | null;
  description: string;
  category_id: string | null;
  card_id: string | null;
  statement_id: string | null;
  recurrence_id: string | null;
  installment_plan_id?: string | null;
  created_at?: Date | string;
  version: number;
}

interface LoanRow {
  id: string;
  workspace_id: string;
  direction: "lent" | "borrowed";
  counterparty: string;
  principal_minor: string | bigint;
  paid_minor: string | bigint;
  currency_code: string;
  occurred_on: string;
  due_on: string | null;
  principal_event_id: string;
  status: "open" | "settled";
  version: number;
}

interface FinanceAuditRow {
  id: string;
  transaction_id: string;
  category: string;
  action: string;
  actor_id: string | null;
  /** Selected as PostgreSQL text so cursor positions retain microseconds. */
  occurred_at: string | Date;
  origin: string;
  correlation_id: string;
  result: string;
  reason: string | null;
  before_redacted: unknown;
  after_redacted: unknown;
}

export class FinanceService {
  private readonly applicationRole: string;
  private readonly cursorSecret: string;
  private readonly clock: Clock;

  constructor(
    private readonly pool: Pool,
    options: FinanceServiceOptions = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
    const cursorSecret = options.cursorSecret ?? process.env.CASEI_CURSOR_SECRET;
    if (process.env.NODE_ENV === "production" && !cursorSecret) {
      throw new Error("CASEI_CURSOR_SECRET is required in production");
    }
    this.cursorSecret = cursorSecret ?? "development-only-cursor-secret";
    this.clock = options.clock ?? systemClock;
  }

  async getWallet(scope: FinanceScope): Promise<WalletView> {
    return this.withUnitOfWork(scope, async ({ client }) => {
      await materializeInitialWalletBalance(client, {
        workspaceId: scope.workspaceId,
        actorId: null,
        correlationId: scope.correlationId,
        origin: "system",
        now: this.clock.now(),
      });
      return this.readWallet(client, scope.workspaceId, "share");
    });
  }

  async previewWalletAdjustment(
    scope: FinanceScope,
    input: unknown,
  ): Promise<WalletAdjustmentPreviewView> {
    const parsed = walletAdjustmentPreviewInputSchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) => {
      await materializeInitialWalletBalance(client, {
        workspaceId: scope.workspaceId,
        actorId: null,
        correlationId: scope.correlationId,
        origin: "system",
        now: this.clock.now(),
      });
      const wallet = await this.readWallet(client, scope.workspaceId, "share");
      if (parsed.observedBalance.currency !== wallet.balance.currency) {
        throw new FinanceConflictError("A moeda do saldo observado difere da carteira.");
      }
      const difference = calculateWalletAdjustment(
        BigInt(wallet.balance.minor),
        BigInt(parsed.observedBalance.minor),
      );
      return {
        wallet,
        observedBalance: parsed.observedBalance,
        difference: { currency: wallet.balance.currency, minor: difference.toString() },
      };
    });
  }

  async adjustWallet(
    scope: FinanceScope,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; adjustment: WalletAdjustmentResultView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = walletAdjustmentInputSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/wallet/adjustments`,
        key: idempotencyKey,
        request: { expectedVersion, ...parsed },
        execute: async () => {
          await materializeInitialWalletBalance(client, {
            workspaceId: scope.workspaceId,
            actorId: null,
            correlationId: scope.correlationId,
            origin: "system",
            now: this.clock.now(),
          });
          const wallet = await this.readWallet(client, scope.workspaceId, "update");
          if (wallet.version !== expectedVersion) throw new VersionConflictError(wallet.version);
          if (parsed.observedBalance.currency !== wallet.balance.currency) {
            throw new FinanceConflictError("A moeda do saldo observado difere da carteira.");
          }
          const differenceMinor = calculateWalletAdjustment(
            BigInt(wallet.balance.minor),
            BigInt(parsed.observedBalance.minor),
          );
          if (differenceMinor === 0n) {
            throw new FinanceConflictError("O saldo observado já confere com a carteira.");
          }
          const occurredOn = await this.workspaceToday(client, scope.workspaceId);
          const amountMinor = differenceMinor < 0n ? -differenceMinor : differenceMinor;
          const inserted = await client.query<TransactionRow>(
            `INSERT INTO finance_transaction
              (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
               occurred_on, due_on, posted_on, cash_settled_on, description, category_id, card_id,
               recurrence_id, installment_plan_id)
             VALUES ($1, 'adjustment', 'posted', 'wallet', $2, $2, $3, $4, NULL, now(), now(),
                     'Ajuste de saldo', NULL, NULL, NULL, NULL)
             RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
                       occurred_on::text AS occurred_on, due_on::text AS due_on, posted_on,
                       description, category_id, card_id,
                       statement_id, recurrence_id, installment_plan_id, version`,
            [scope.workspaceId, amountMinor, wallet.balance.currency, occurredOn],
          );
          const transactionRow = inserted.rows[0];
          if (!transactionRow) throw new Error("wallet adjustment transaction insert failed");
          const accounts = await this.walletAdjustmentAccounts(
            client,
            scope.workspaceId,
            wallet.balance.currency,
          );
          const postings = canonicalWalletAdjustmentPostings({
            delta: Money.fromTrusted(differenceMinor, wallet.balance.currency as never),
            accounts,
          });
          await this.publishEvent(
            client,
            scope,
            transactionRow.id,
            "wallet.adjusted.v1",
            wallet.balance.currency,
            postings.map((posting) => ({
              accountId: posting.accountId,
              amount: posting.amount.minor,
            })),
            occurredOn,
          );
          await client.query(
            `INSERT INTO audit_event
              (category, action, actor_id, workspace_id, target_type, target_id, origin,
               correlation_id, result, reason, before_redacted, after_redacted)
             VALUES ('finance', 'wallet.adjusted', $1, $2, 'finance_transaction', $3, 'api', $4,
                     'success', $5, $6::jsonb, $7::jsonb)`,
            [
              scope.actorId,
              scope.workspaceId,
              transactionRow.id,
              scope.correlationId,
              parsed.reason,
              JSON.stringify({ kind: "adjustment", state: "posted", version: expectedVersion }),
              JSON.stringify({
                kind: "adjustment",
                state: "posted",
                version: expectedVersion + 1,
              }),
            ],
          );
          const nextWallet = await this.readWallet(client, scope.workspaceId, "update");
          const adjustment: WalletAdjustmentResultView = {
            wallet: nextWallet,
            observedBalance: parsed.observedBalance,
            difference: {
              currency: wallet.balance.currency,
              minor: differenceMinor.toString(),
            },
            transaction: toTransactionView(transactionRow),
          };
          return { statusCode: 201, response: adjustment as unknown as JsonValue };
        },
      }),
    );
    return {
      replayed: result.replayed,
      adjustment: result.response as unknown as WalletAdjustmentResultView,
    };
  }

  async createLoan(
    scope: FinanceScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; loan: LoanView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createLoanSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/loans`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          if (parsed.principal.currency !== currency) {
            throw new FinanceConflictError("A moeda do empréstimo difere da carteira.");
          }
          const occurredOn =
            parsed.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId));
          if (parsed.dueOn && parsed.dueOn < occurredOn) {
            throw new FinanceConflictError(
              "O vencimento não pode ser anterior à data do empréstimo.",
            );
          }
          const ids = await client.query<{ loan_id: string; event_id: string }>(
            `SELECT uuidv7() AS loan_id, uuidv7() AS event_id`,
          );
          const loanId = ids.rows[0]?.loan_id;
          const eventId = ids.rows[0]?.event_id;
          if (!loanId || !eventId) throw new Error("loan identifiers were not generated");
          await client.query(
            `INSERT INTO loan_contract
              (id, workspace_id, direction, counterparty, principal_minor, paid_minor,
               currency_code, occurred_on, due_on, principal_event_id, status, version)
             VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, 'open', 0)`,
            [
              loanId,
              scope.workspaceId,
              parsed.direction,
              parsed.counterparty,
              BigInt(parsed.principal.minor),
              currency,
              occurredOn,
              parsed.dueOn ?? null,
              eventId,
            ],
          );
          const wallet = await this.ensureAccount(
            client,
            scope.workspaceId,
            "wallet",
            "Carteira",
            currency,
          );
          const loanAccount = await this.ensureAccount(
            client,
            scope.workspaceId,
            loanAccountKind(parsed.direction),
            loanAccountName(loanId),
            currency,
          );
          const postings = canonicalLoanPrincipalPostings({
            direction: parsed.direction,
            amount: Money.fromTrusted(BigInt(parsed.principal.minor), currency as never),
            accounts: { wallet, loan: loanAccount },
          });
          await this.publishLoanEvent(
            client,
            scope,
            eventId,
            loanEventType(parsed.direction, "principal"),
            currency,
            postings.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
            occurredOn,
          );
          const row = await this.getLoanRow(client, scope.workspaceId, loanId);
          if (!row) throw new Error("loan contract was not created");
          const loan = toLoanView(row);
          await this.recordLoanAudit(client, scope, loanId, "loan.created", null, loan);
          return { statusCode: 201, response: loan as unknown as JsonValue };
        },
      }),
    );
    return {
      replayed: result.replayed,
      loan: result.response as unknown as LoanView,
    };
  }

  async getLoan(scope: FinanceScope, id: string): Promise<LoanView | null> {
    return this.withScopedClient(scope, async (client) => {
      const row = await this.getLoanRow(client, scope.workspaceId, id);
      return row ? toLoanView(row) : null;
    });
  }

  async listLoans(scope: FinanceScope, limit = 50): Promise<LoanView[]> {
    return this.withScopedClient(scope, async (client) => {
      const boundedLimit = Math.min(Math.max(limit, 1), 100);
      const result = await client.query<LoanRow>(
        `SELECT id, workspace_id, direction, counterparty, principal_minor, paid_minor,
                currency_code, occurred_on::text AS occurred_on, due_on::text AS due_on,
                principal_event_id, status, version
           FROM loan_contract
          WHERE workspace_id = $1
          ORDER BY status ASC, due_on ASC NULLS LAST, occurred_on DESC, id DESC
          LIMIT $2`,
        [scope.workspaceId, boundedLimit],
      );
      return result.rows.map(toLoanView);
    });
  }

  async payLoan(
    scope: FinanceScope,
    loanId: string,
    idempotencyKey: string,
    expectedVersion: number,
    input: unknown,
  ): Promise<{ replayed: boolean; response: LoanPaymentResponse }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = loanPaymentSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/loans/${loanId}/payments`,
        key: idempotencyKey,
        request: { loanId, expectedVersion, parsed },
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          const current = await client.query<LoanRow>(
            `SELECT id, workspace_id, direction, counterparty, principal_minor, paid_minor,
                    currency_code, occurred_on::text AS occurred_on, due_on::text AS due_on,
                    principal_event_id, status, version
               FROM loan_contract
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, loanId],
          );
          const row = current.rows[0];
          if (!row) throw new FinanceNotFoundError();
          if (row.version !== expectedVersion) throw new VersionConflictError(row.version);
          if (row.status !== "open") {
            throw new FinanceConflictError("O empréstimo já está liquidado.");
          }
          if (row.currency_code !== currency || parsed.amount.currency !== row.currency_code) {
            throw new FinanceConflictError("A moeda do pagamento difere do empréstimo.");
          }
          const principal = BigInt(row.principal_minor);
          const paid = BigInt(row.paid_minor);
          const amount = BigInt(parsed.amount.minor);
          const remaining = principal - paid;
          if (amount > remaining) {
            throw new FinanceConflictError("O pagamento excede o saldo do empréstimo.");
          }
          const occurredOn =
            parsed.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId));
          if (occurredOn < row.occurred_on) {
            throw new FinanceConflictError(
              "A data do pagamento não pode ser anterior à data do empréstimo.",
            );
          }
          const ids = await client.query<{ payment_id: string; event_id: string }>(
            `SELECT uuidv7() AS payment_id, uuidv7() AS event_id`,
          );
          const paymentId = ids.rows[0]?.payment_id;
          const eventId = ids.rows[0]?.event_id;
          if (!paymentId || !eventId)
            throw new Error("loan payment identifiers were not generated");
          const wallet = await this.ensureAccount(
            client,
            scope.workspaceId,
            "wallet",
            "Carteira",
            currency,
          );
          const loanAccount = await this.ensureAccount(
            client,
            scope.workspaceId,
            loanAccountKind(row.direction),
            loanAccountName(row.id),
            currency,
          );
          const postings = canonicalLoanPaymentPostings({
            direction: row.direction,
            amount: Money.fromTrusted(amount, currency as never),
            accounts: { wallet, loan: loanAccount },
          });
          await this.publishLoanEvent(
            client,
            scope,
            eventId,
            loanEventType(row.direction, "payment"),
            currency,
            postings.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
            occurredOn,
          );
          await client.query(
            `INSERT INTO loan_payment
              (id, workspace_id, loan_id, amount_minor, currency_code, occurred_on, ledger_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [paymentId, scope.workspaceId, loanId, amount, currency, occurredOn, eventId],
          );
          const nextPaid = paid + amount;
          const updated = await client.query<LoanRow>(
            `UPDATE loan_contract
                SET paid_minor = $3, status = CASE WHEN $3 = principal_minor THEN 'settled' ELSE 'open' END,
                    version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $4
              RETURNING id, workspace_id, direction, counterparty, principal_minor, paid_minor,
                        currency_code, occurred_on::text AS occurred_on, due_on::text AS due_on,
                        principal_event_id, status, version`,
            [scope.workspaceId, loanId, nextPaid, expectedVersion],
          );
          const next = updated.rows[0];
          if (!next) throw new VersionConflictError();
          const loan = toLoanView(next);
          const payment: LoanPaymentView = {
            id: paymentId,
            loanId,
            amount: { currency, minor: amount.toString() },
            occurredOn,
          };
          await this.recordLoanAudit(client, scope, loanId, "loan.payment", toLoanView(row), loan);
          return { statusCode: 200, response: { loan, payment } as unknown as JsonValue };
        },
      }),
    );
    return {
      replayed: result.replayed,
      response: result.response as unknown as LoanPaymentResponse,
    };
  }

  async createTransaction(
    scope: FinanceScope,
    input: unknown,
    idempotencyKey: string,
    command = "transactions",
  ): Promise<{ replayed: boolean; transaction: TransactionView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createTransactionSchema.parse(input);
    if (parsed.kind === "adjustment") {
      throw new FinanceConflictError(
        "Ajustes exigem o comando de conferência com motivo e saldo observado.",
      );
    }
    const result = await this.withUnitOfWork(scope, async ({ client }) => {
      return executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/${command}`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const transaction = await this.insertTransaction(client, scope, parsed);
          return { statusCode: 201, response: transaction as unknown as JsonValue };
        },
      });
    });
    return {
      replayed: result.replayed,
      transaction: result.response as unknown as TransactionView,
    };
  }

  async updateTransaction(
    scope: FinanceScope,
    id: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; transaction: TransactionView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = updateTransactionSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:PATCH:/transactions/${id}`,
        key: idempotencyKey,
        request: { id, expectedVersion, ...parsed },
        execute: async () => {
          const currentResult = await client.query<TransactionRow>(
            `SELECT id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
                    occurred_on, due_on, posted_on, description, category_id, card_id, statement_id,
                    recurrence_id, installment_plan_id, version
               FROM finance_transaction
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, id],
          );
          const current = currentResult.rows[0];
          if (!current) throw new FinanceNotFoundError();
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (current.recurrence_id) {
            throw new FinanceConflictError(
              "Edite a série de recorrência pelo comando de série, não pela ocorrência.",
            );
          }
          if (current.installment_plan_id) {
            throw new FinanceConflictError(
              "Edite o parcelamento pelo comando do plano, não pela parcela individual.",
            );
          }
          if (current.card_id || current.statement_id) {
            throw new FinanceConflictError(
              "Compras de cartão devem ser corrigidas pela fatura; a edição direta ainda não é permitida.",
            );
          }
          const changesEconomicFields =
            parsed.amount !== undefined ||
            parsed.occurredOn !== undefined ||
            parsed.dueOn !== undefined;
          if (changesEconomicFields && current.state !== "planned") {
            throw new FinanceConflictError(
              "Valor e datas só podem ser alterados enquanto o compromisso estiver planejado.",
            );
          }

          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          const nextAmount = parsed.amount?.minor ?? current.amount_minor.toString();
          if (parsed.amount && parsed.amount.currency !== currency) {
            throw new FinanceConflictError("A moeda da transação difere da moeda do espaço.");
          }
          const nextOccurredOn = parsed.occurredOn ?? current.occurred_on;
          const nextDueOn = parsed.dueOn === undefined ? current.due_on : parsed.dueOn;
          if (!parseLocalDate(nextOccurredOn).ok || (nextDueOn && !parseLocalDate(nextDueOn).ok)) {
            throw new FinanceConflictError("A data civil informada não existe.");
          }
          const nextDescription = parsed.description ?? current.description;
          const nextCategoryId =
            parsed.categoryId === undefined ? current.category_id : parsed.categoryId;
          if (parsed.categoryId !== undefined && nextCategoryId) {
            const category = await client.query<{
              kind: "income" | "expense" | "both";
              archived: boolean;
            }>(
              `SELECT kind, archived
                 FROM finance_category
                WHERE workspace_id = $1 AND id = $2
                FOR SHARE`,
              [scope.workspaceId, nextCategoryId],
            );
            const categoryRow = category.rows[0];
            if (!categoryRow || categoryRow.archived) {
              throw new FinanceConflictError(
                "A categoria não está disponível para novos lançamentos.",
              );
            }
            if (
              (current.kind === "income" && !["income", "both"].includes(categoryRow.kind)) ||
              (current.kind === "expense" && !["expense", "both"].includes(categoryRow.kind))
            ) {
              throw new FinanceConflictError(
                "A categoria não é compatível com o tipo da transação.",
              );
            }
          }

          const updated = await client.query<TransactionRow>(
            `UPDATE finance_transaction
                SET amount_minor = $3,
                    occurred_on = $4,
                    due_on = $5,
                    description = $6,
                    category_id = $7,
                    version = version + 1,
                    updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $8
              RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
                        occurred_on, due_on, posted_on, description, category_id, card_id, statement_id,
                        recurrence_id, version`,
            [
              scope.workspaceId,
              id,
              BigInt(nextAmount),
              nextOccurredOn,
              nextDueOn,
              nextDescription,
              nextCategoryId,
              expectedVersion,
            ],
          );
          const row = updated.rows[0];
          if (!row) throw new VersionConflictError(current.version);
          await this.recordTransactionAudit(
            client,
            scope,
            id,
            "transaction.updated",
            transactionAuditSnapshot(current),
            transactionAuditSnapshot(row),
          );
          return { statusCode: 200, response: toTransactionView(row) as unknown as JsonValue };
        },
      }),
    );
    return {
      replayed: result.replayed,
      transaction: result.response as unknown as TransactionView,
    };
  }

  async listTransactions(
    scope: FinanceScope,
    options: Partial<TransactionListQuery> = {},
  ): Promise<{ items: TransactionView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.withScopedClient(scope, async (client) => {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const values: unknown[] = [scope.workspaceId];
      const conditions = ["t.workspace_id = $1"];
      const addValue = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      if (options.search) {
        const parameter = addValue(`%${options.search}%`);
        conditions.push(`t.description ILIKE ${parameter}`);
      }
      if (options.from) conditions.push(`t.occurred_on >= ${addValue(options.from)}::date`);
      if (options.to) conditions.push(`t.occurred_on <= ${addValue(options.to)}::date`);
      if (options.state) conditions.push(`t.state = ${addValue(options.state)}`);
      if (options.kind) conditions.push(`t.kind = ${addValue(options.kind)}`);
      if (options.cardId) conditions.push(`t.card_id = ${addValue(options.cardId)}::uuid`);

      const cursor = options.cursor
        ? decodeTransactionCursor(options.cursor, this.cursorSecret)
        : null;
      if (cursor) {
        const occurredOn = addValue(cursor[0]);
        const createdAt = addValue(cursor[1]);
        const id = addValue(cursor[2]);
        conditions.push(
          `(t.occurred_on < ${occurredOn}::date OR (t.occurred_on = ${occurredOn}::date AND t.created_at < ${createdAt}::timestamptz) OR (t.occurred_on = ${occurredOn}::date AND t.created_at = ${createdAt}::timestamptz AND t.id < ${id}::uuid))`,
        );
      }

      const limitParameter = addValue(limit + 1);
      const result = await client.query<TransactionRow>(
        `SELECT id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
                occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, created_at, version
           FROM finance_transaction
          WHERE ${conditions.join(" AND ")}
          ORDER BY occurred_on DESC, created_at DESC, id DESC
          LIMIT ${limitParameter}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last?.created_at
          ? encodeCursor(
              {
                ordering: transactionCursorOrdering,
                position: [last.occurred_on, new Date(last.created_at).toISOString(), last.id],
              },
              this.cursorSecret,
            )
          : null;
      return { items: rows.map(toTransactionView), nextCursor, hasMore };
    });
  }

  async getTransaction(scope: FinanceScope, id: string): Promise<TransactionView | null> {
    return this.withScopedClient(scope, async (client) => {
      const result = await client.query<TransactionRow>(
        `SELECT id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
                occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version
           FROM finance_transaction WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, id],
      );
      return result.rows[0] ? toTransactionView(result.rows[0]) : null;
    });
  }

  async listTransactionAudit(
    scope: FinanceScope,
    transactionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<FinanceAuditPage> {
    return this.withScopedClient(scope, async (client) => {
      const transaction = await client.query<{ id: string }>(
        `SELECT id FROM finance_transaction WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, transactionId],
      );
      if (!transaction.rows[0]) throw new FinanceNotFoundError();

      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const cursor = options.cursor
        ? decodeFinanceAuditCursor(options.cursor, this.cursorSecret)
        : null;
      const values: unknown[] = [scope.workspaceId, transactionId];
      const conditions = [
        "workspace_id = $1",
        "target_type = 'finance_transaction'",
        "target_id = $2",
      ];
      if (cursor) {
        values.push(cursor[0], cursor[1]);
        conditions.push(
          `(occurred_at < $${values.length - 1}::timestamptz OR (occurred_at = $${values.length - 1}::timestamptz AND id < $${values.length}::uuid))`,
        );
      }
      values.push(limit + 1);
      const result = await client.query<FinanceAuditRow>(
        `SELECT id, target_id AS transaction_id, category, action, actor_id,
                occurred_at::text AS occurred_at,
                origin, correlation_id, result, reason, before_redacted, after_redacted
           FROM audit_event
          WHERE ${conditions.join(" AND ")}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const last = rows.at(-1);
      return {
        items: rows.map(toFinanceAuditEventView),
        nextCursor:
          hasMore && last
            ? encodeCursor(
                {
                  ordering: financeAuditCursorOrdering,
                  position: [normalizePostgresTimestamp(last.occurred_at), last.id],
                },
                this.cursorSecret,
              )
            : null,
        hasMore,
      };
    });
  }

  async getTransactionAudit(
    scope: FinanceScope,
    transactionId: string,
    auditId: string,
  ): Promise<FinanceAuditDetailView> {
    return this.withScopedClient(scope, async (client) => {
      const transaction = await client.query<{ id: string }>(
        `SELECT id FROM finance_transaction WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, transactionId],
      );
      if (!transaction.rows[0]) throw new FinanceNotFoundError();
      const event = await client.query<FinanceAuditRow>(
        `SELECT id, target_id AS transaction_id, category, action, actor_id,
                occurred_at::text AS occurred_at,
                origin, correlation_id, result, reason, before_redacted, after_redacted
           FROM audit_event
          WHERE workspace_id = $1 AND target_type = 'finance_transaction'
            AND target_id = $2 AND id = $3`,
        [scope.workspaceId, transactionId, auditId],
      );
      const row = event.rows[0];
      if (!row) throw new FinanceNotFoundError();
      const consequences = await client.query<{
        id: string;
        event_type: string;
        status: string;
        occurred_on: string;
        published_at: Date | string | null;
        reversed_event_id: string | null;
      }>(
        `SELECT id, event_type, status, occurred_on, published_at, reversed_event_id
           FROM ledger_event
          WHERE workspace_id = $1 AND transaction_id = $2
          ORDER BY occurred_on ASC, created_at ASC, id ASC`,
        [scope.workspaceId, transactionId],
      );
      return {
        ...toFinanceAuditEventView(row),
        consequences: {
          ledgerEvents: consequences.rows.map((value) => ({
            id: value.id,
            eventType: value.event_type,
            status: value.status,
            occurredOn: value.occurred_on,
            publishedAt: value.published_at ? new Date(value.published_at).toISOString() : null,
            reversedEventId: value.reversed_event_id,
          })),
        },
      };
    });
  }

  async listCategories(scope: FinanceScope, limit = 100): Promise<CategoryView[]> {
    return this.withScopedClient(scope, async (client) => {
      const result = await client.query(
        `SELECT id, workspace_id, name, kind, archived, version
           FROM finance_category
          WHERE workspace_id = $1
          ORDER BY archived ASC, lower(name) ASC, id ASC
          LIMIT $2`,
        [scope.workspaceId, Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(toCategoryView);
    });
  }

  async listCards(scope: FinanceScope, limit = 100): Promise<CreditCardView[]> {
    return this.withScopedClient(scope, async (client) => {
      const result = await client.query(
        `SELECT id, workspace_id, name, closing_day, due_day, holder, last_four,
                limit_minor, currency_code, archived, version
           FROM credit_card
          WHERE workspace_id = $1
          ORDER BY archived ASC, lower(name) ASC, id ASC
          LIMIT $2`,
        [scope.workspaceId, Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(toCreditCardView);
    });
  }

  async listStatements(
    scope: FinanceScope,
    cardId?: string,
    limit = 100,
  ): Promise<StatementView[]> {
    return this.withScopedClient(scope, async (client) => {
      const result = await client.query(
        `SELECT id, workspace_id, card_id, period_start, closing_on, due_on, state,
                total_minor, paid_minor, currency_code, version
           FROM (
             SELECT s.id, s.workspace_id, s.card_id, s.period_start, s.closing_on, s.due_on,
                    s.state, s.total_minor, s.paid_minor, c.currency_code, s.version
               FROM credit_statement s
               JOIN credit_card c ON c.workspace_id = s.workspace_id AND c.id = s.card_id
              WHERE s.workspace_id = $1
                AND ($2::uuid IS NULL OR s.card_id = $2::uuid)
           ) statements
          ORDER BY closing_on DESC, id DESC
          LIMIT $3`,
        [scope.workspaceId, cardId ?? null, Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(toStatementView);
    });
  }

  async getStatement(scope: FinanceScope, statementId: string): Promise<StatementView | null> {
    return this.withScopedClient(scope, async (client) => {
      const result = await client.query<{
        id: string;
        workspace_id: string;
        card_id: string;
        period_start: string;
        closing_on: string;
        due_on: string;
        state: StatementView["state"];
        total_minor: string | bigint;
        paid_minor: string | bigint;
        currency_code: string;
        version: number;
      }>(
        `SELECT s.id, s.workspace_id, s.card_id, s.period_start, s.closing_on, s.due_on,
                s.state, s.total_minor, s.paid_minor, c.currency_code, s.version
           FROM credit_statement s
           JOIN credit_card c ON c.workspace_id = s.workspace_id AND c.id = s.card_id
          WHERE s.workspace_id = $1 AND s.id = $2`,
        [scope.workspaceId, statementId],
      );
      const row = result.rows[0];
      return row ? toStatementView(row) : null;
    });
  }

  async listStatementItems(
    scope: FinanceScope,
    statementId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<StatementItemsPage> {
    return this.withScopedClient(scope, async (client) => {
      const statement = await client.query<{ id: string }>(
        `SELECT id FROM credit_statement WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, statementId],
      );
      if (!statement.rows[0]) throw new FinanceNotFoundError();
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const cursor = options.cursor
        ? decodeStatementItemsCursor(options.cursor, this.cursorSecret)
        : null;
      const values: unknown[] = [scope.workspaceId, statementId];
      const cursorClause = cursor
        ? `
             AND (
               t.occurred_on > $3::date
               OR (t.occurred_on = $3::date AND t.created_at > $4::timestamptz)
               OR (t.occurred_on = $3::date AND t.created_at = $4::timestamptz AND t.id > $5::uuid)
             )`
        : "";
      if (cursor) values.push(cursor[0], cursor[1], cursor[2]);
      const limitParameter = values.length + 1;
      values.push(limit + 1);
      const result = await client.query<{
        id: string;
        statement_id: string;
        state: StatementItemView["state"];
        description: string;
        occurred_on: string;
        created_at: Date | string;
        amount_minor: string | bigint;
        currency_code: string;
        payment_id: string | null;
      }>(
        `SELECT t.id, t.statement_id, t.state, t.description, t.occurred_on,
                t.created_at, t.amount_minor, t.currency_code, p.id AS payment_id
           FROM finance_transaction t
           LEFT JOIN card_payment p
             ON p.workspace_id = t.workspace_id AND p.transaction_id = t.id
          WHERE t.workspace_id = $1 AND t.statement_id = $2
                ${cursorClause}
          ORDER BY t.occurred_on ASC, t.created_at ASC, t.id ASC
          LIMIT $${limitParameter}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const items = rows.map((row) => ({
        id: row.id,
        transactionId: row.id,
        statementId: row.statement_id,
        type: row.payment_id ? ("payment" as const) : ("purchase" as const),
        state: row.state,
        description: row.description,
        occurredOn: row.occurred_on,
        amount: { currency: row.currency_code, minor: row.amount_minor.toString() },
      }));
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor(
              {
                ordering: statementItemsCursorOrdering,
                position: [last.occurred_on, new Date(last.created_at).toISOString(), last.id],
              },
              this.cursorSecret,
            )
          : null;
      return { items, nextCursor, hasMore };
    });
  }

  async closeStatement(
    scope: FinanceScope,
    statementId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<StatementView> {
    assertFinanceCapability(scope, "finance.write");
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/statements/${statementId}/close`,
        key: idempotencyKey,
        request: { statementId, expectedVersion },
        execute: async () => {
          const current = await client.query(
            `SELECT s.id, s.workspace_id, s.card_id, s.period_start, s.closing_on, s.due_on,
                    s.state, s.total_minor, s.paid_minor, c.currency_code, s.version
               FROM credit_statement s
               JOIN credit_card c ON c.workspace_id = s.workspace_id AND c.id = s.card_id
              WHERE s.workspace_id = $1 AND s.id = $2
              FOR UPDATE`,
            [scope.workspaceId, statementId],
          );
          const row = current.rows[0] as Record<string, unknown> | undefined;
          if (!row) throw new FinanceNotFoundError();
          if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) {
            throw new VersionConflictError(Number(row.version));
          }
          if (row.state !== "open") {
            throw new FinanceConflictError("Somente uma fatura aberta pode ser fechada.");
          }
          const updated = await client.query(
            `UPDATE credit_statement
                SET state = 'closed', version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $3
              RETURNING id, workspace_id, card_id, period_start, closing_on, due_on,
                        state, total_minor, paid_minor, $4::varchar AS currency_code, version`,
            [scope.workspaceId, statementId, Number(row.version), row.currency_code],
          );
          const value = updated.rows[0];
          if (!value) throw new VersionConflictError();
          await this.recordStatementAudit(client, scope, statementId, "statement.closed");
          return { statusCode: 200, response: toStatementView(value) as unknown as JsonValue };
        },
      }),
    );
    return result.response as unknown as StatementView;
  }

  async reopenStatement(
    scope: FinanceScope,
    statementId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<StatementView> {
    assertFinanceCapability(scope, "finance.write");
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/statements/${statementId}/reopen`,
        key: idempotencyKey,
        request: { statementId, expectedVersion, confirm: true },
        execute: async () => {
          const current = await client.query(
            `SELECT s.id, s.workspace_id, s.card_id, s.period_start, s.closing_on, s.due_on,
                    s.state, s.total_minor, s.paid_minor, c.currency_code, s.version
               FROM credit_statement s
               JOIN credit_card c ON c.workspace_id = s.workspace_id AND c.id = s.card_id
              WHERE s.workspace_id = $1 AND s.id = $2
              FOR UPDATE`,
            [scope.workspaceId, statementId],
          );
          const row = current.rows[0] as Record<string, unknown> | undefined;
          if (!row) throw new FinanceNotFoundError();
          if (Number(row.version) !== expectedVersion)
            throw new VersionConflictError(Number(row.version));
          assertStatementCanReopen({
            state: String(row.state),
            paidMinor: BigInt(String(row.paid_minor)),
          });
          const updated = await client.query(
            `UPDATE credit_statement
                SET state = 'open', version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $3
              RETURNING id, workspace_id, card_id, period_start, closing_on, due_on,
                        state, total_minor, paid_minor, $4::varchar AS currency_code, version`,
            [scope.workspaceId, statementId, expectedVersion, row.currency_code],
          );
          const value = updated.rows[0];
          if (!value) throw new VersionConflictError();
          await this.recordStatementAudit(client, scope, statementId, "statement.reopened");
          return { statusCode: 200, response: toStatementView(value) as unknown as JsonValue };
        },
      }),
    );
    return result.response as unknown as StatementView;
  }

  async postTransaction(
    scope: FinanceScope,
    id: string,
    idempotencyKey: string,
    expectedVersion?: number,
    input: unknown = {},
  ): Promise<TransactionView> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = settleTransactionSchema.parse(input);
    return this.mutateTransaction(
      scope,
      id,
      idempotencyKey,
      expectedVersion,
      "transactions/:id/post",
      { id, expectedVersion, ...parsed },
      async (client, row) => {
        const workspaceCurrency = await this.workspaceCurrency(client, scope.workspaceId);
        if (row.currency_code !== workspaceCurrency) {
          throw new FinanceConflictError(
            "A moeda da transação não corresponde mais à moeda do espaço.",
          );
        }
        if (row.state !== "planned" && row.state !== "partially_settled") {
          throw new FinanceConflictError("Somente uma transação planejada pode ser realizada.");
        }
        if (row.recurrence_id) {
          const recurrence = await client.query<{ variable: boolean }>(
            `SELECT r.variable
               FROM recurrence_occurrence o
               JOIN recurrence_rule r ON r.id = o.recurrence_id
              WHERE o.workspace_id = $1 AND o.transaction_id = $2
              FOR SHARE`,
            [scope.workspaceId, id],
          );
          assertVariableRecurrenceSettlementAllowed(
            recurrence.rows[0]?.variable ?? false,
            parsed.amount !== undefined,
          );
        }
        if (parsed.amount && parsed.amount.currency !== row.currency_code) {
          throw new FinanceConflictError("A moeda da liquidação difere da transação.");
        }
        const settlement = calculateSettlement({
          plannedMinor: BigInt(row.amount_minor),
          settledMinor: BigInt(row.settled_minor),
          effectiveMinor: parsed.amount ? BigInt(parsed.amount.minor) : undefined,
        });
        const { amountMinor: amount, settledMinor, state: nextState } = settlement;
        const settlementOn =
          parsed.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId));
        await this.publishTransaction(
          client,
          scope,
          row,
          amount,
          settlementOn,
          nextState === "posted" ? "transaction.posted.v1" : "transaction.partially_settled.v1",
        );
        const result = await client.query<TransactionRow>(
          `UPDATE finance_transaction
            SET state = $3, settled_minor = $4, posted_on = coalesce(posted_on, now()), cash_settled_on = CASE WHEN instrument = 'wallet' THEN coalesce(cash_settled_on, now()) ELSE cash_settled_on END, version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND version = $5
          RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version`,
          [scope.workspaceId, id, nextState, settledMinor, row.version],
        );
        if (!result.rows[0]) throw new VersionConflictError();
        await this.recordTransactionAudit(
          client,
          scope,
          id,
          nextState === "posted" ? "transaction.posted" : "transaction.partially_settled",
          transactionAuditSnapshot(row),
          transactionAuditSnapshot(result.rows[0]),
        );
        return toTransactionView(result.rows[0]);
      },
    );
  }

  async reverseTransaction(
    scope: FinanceScope,
    id: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<TransactionView> {
    assertFinanceCapability(scope, "finance.write");
    return this.mutateTransaction(
      scope,
      id,
      idempotencyKey,
      expectedVersion,
      "transactions/:id/reverse",
      { id, expectedVersion },
      async (client, row) => {
        if (row.state !== "posted" && row.state !== "partially_settled") {
          throw new FinanceConflictError("A transação não está realizada.");
        }
        const original = await client.query<{
          id: string;
          currency_code: string;
          occurred_on: string;
        }>(
          `SELECT id, currency_code, occurred_on
             FROM ledger_event
            WHERE workspace_id = $1
              AND transaction_id = $2
              AND event_type IN ('transaction.posted.v1', 'transaction.partially_settled.v1', 'statement.payment.v1')
              AND status = 'published'
              AND reversed_event_id IS NULL
            ORDER BY created_at ASC`,
          [scope.workspaceId, id],
        );
        if (original.rows.length === 0)
          throw new FinanceConflictError("O lançamento original não foi encontrado.");
        const cardPayment = row.statement_id
          ? await client.query<{ amount_minor: string }>(
              `SELECT amount_minor
                 FROM card_payment
                WHERE workspace_id = $1 AND statement_id = $2 AND transaction_id = $3`,
              [scope.workspaceId, row.statement_id, id],
            )
          : { rows: [] as { amount_minor: string }[] };
        if (row.statement_id && cardPayment.rows[0]) {
          const paymentAmount = BigInt(cardPayment.rows[0].amount_minor);
          const statement = await client.query<{
            state: string;
            total_minor: string;
            paid_minor: string;
          }>(
            `SELECT state, total_minor, paid_minor
               FROM credit_statement
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, row.statement_id],
          );
          const statementRow = statement.rows[0];
          if (!statementRow) throw new FinanceNotFoundError();
          if (statementRow.state === "canceled") {
            throw new FinanceConflictError(
              "A fatura cancelada não aceita cancelamento de pagamento.",
            );
          }
          const paid = BigInt(statementRow.paid_minor) - paymentAmount;
          if (paid < 0n)
            throw new FinanceConflictError("O pagamento já não está refletido na fatura.");
          await client.query(
            `UPDATE credit_statement
                SET paid_minor = $1,
                    state = CASE WHEN $1 = 0 THEN 'closed' ELSE 'partially_paid' END,
                    version = version + 1,
                    updated_at = now()
              WHERE workspace_id = $2 AND id = $3`,
            [paid, scope.workspaceId, row.statement_id],
          );
        } else if (row.statement_id) {
          const statement = await client.query<{
            state: string;
            total_minor: string;
            paid_minor: string;
          }>(
            `SELECT state, total_minor, paid_minor
               FROM credit_statement
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, row.statement_id],
          );
          const statementRow = statement.rows[0];
          if (!statementRow) throw new FinanceNotFoundError();
          if (statementRow.state !== "open") {
            throw new FinanceConflictError(
              "A fatura já foi fechada ou paga; faça um ajuste explícito para estornar esta compra.",
            );
          }
          const nextTotal = BigInt(statementRow.total_minor) - BigInt(row.settled_minor);
          if (nextTotal < BigInt(statementRow.paid_minor)) {
            throw new FinanceConflictError("O estorno excede o saldo aberto da fatura.");
          }
          await client.query(
            `UPDATE credit_statement
                SET total_minor = $1, version = version + 1, updated_at = now()
              WHERE workspace_id = $2 AND id = $3`,
            [nextTotal, scope.workspaceId, row.statement_id],
          );
        }
        for (const [index, sourceEvent] of original.rows.entries()) {
          const entries = await client.query<{
            account_id: string;
            currency_code: string;
            amount_minor: string;
          }>(
            `SELECT account_id, currency_code, amount_minor FROM ledger_entry WHERE workspace_id = $1 AND event_id = $2`,
            [scope.workspaceId, sourceEvent.id],
          );
          const eventType =
            index === 0 ? "transaction.reversed.v1" : `transaction.reversed.v1.${index + 1}`;
          const reversal = await client.query<{ id: string }>(
            `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at, reversed_event_id)
           VALUES ($1, $2, $3, $4, 'published', $5, now(), $6) RETURNING id`,
            [
              scope.workspaceId,
              id,
              eventType,
              sourceEvent.currency_code,
              sourceEvent.occurred_on,
              sourceEvent.id,
            ],
          );
          for (const entry of entries.rows) {
            await client.query(
              `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
              [
                scope.workspaceId,
                reversal.rows[0]?.id,
                entry.account_id,
                entry.currency_code,
                -BigInt(entry.amount_minor),
              ],
            );
          }
        }
        const result = await client.query<TransactionRow>(
          `UPDATE finance_transaction SET state = 'canceled', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version`,
          [scope.workspaceId, id, row.version],
        );
        if (!result.rows[0]) throw new VersionConflictError();
        await this.recordTransactionAudit(
          client,
          scope,
          id,
          "transaction.reversed",
          transactionAuditSnapshot(row),
          transactionAuditSnapshot(result.rows[0]),
        );
        return toTransactionView(result.rows[0]);
      },
    );
  }

  async createCategory(scope: FinanceScope, input: unknown, idempotencyKey: string) {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createCategorySchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/categories`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const result = await client
            .query<{
              id: string;
              workspace_id: string;
              name: string;
              kind: "income" | "expense" | "both";
              archived: boolean;
              version: number;
            }>(
              `INSERT INTO finance_category (workspace_id, name, kind) VALUES ($1, $2, $3) RETURNING id, workspace_id, name, kind, archived, version`,
              [scope.workspaceId, parsed.name, parsed.kind],
            )
            .catch((error: unknown) => {
              if (isUniqueViolation(error)) {
                throw new FinanceConflictError("Já existe uma categoria ativa com este nome.");
              }
              throw error;
            });
          const row = result.rows[0];
          if (!row) throw new Error("category insert failed");
          await this.recordCategoryAudit(client, scope, row.id, "category.created", {
            before: {},
            after: { name: row.name, kind: row.kind, archived: row.archived },
          });
          return { statusCode: 201, response: toCategoryView(row) as unknown as JsonValue };
        },
      }),
    );
  }

  async updateCategory(
    scope: FinanceScope,
    categoryId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; category: CategoryView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = updateCategorySchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:PATCH:/categories/${categoryId}`,
        key: idempotencyKey,
        request: { categoryId, expectedVersion, ...parsed },
        execute: async () => {
          const currentResult = await client.query<{
            id: string;
            workspace_id: string;
            name: string;
            kind: "income" | "expense" | "both";
            archived: boolean;
            version: number;
          }>(
            `SELECT id, workspace_id, name, kind, archived, version
               FROM finance_category
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, categoryId],
          );
          const current = currentResult.rows[0];
          if (!current) throw new FinanceNotFoundError();
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (current.archived) throw new FinanceConflictError("A categoria está arquivada.");
          const nextName = parsed.name ?? current.name;
          const nextKind = parsed.kind ?? current.kind;
          await assertCategoryNameAvailable(client, scope.workspaceId, nextName, categoryId);
          if (nextKind !== current.kind) {
            const incompatible = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM finance_transaction
                WHERE workspace_id = $1 AND category_id = $2
                  AND ((kind = 'income' AND $3::text = 'expense')
                    OR (kind = 'expense' AND $3::text = 'income'))`,
              [scope.workspaceId, categoryId, nextKind],
            );
            if (Number(incompatible.rows[0]?.count ?? "0") > 0) {
              throw new FinanceConflictError(
                "A categoria já possui lançamentos incompatíveis com este tipo.",
              );
            }
          }
          const updated = await client
            .query<{
              id: string;
              workspace_id: string;
              name: string;
              kind: "income" | "expense" | "both";
              archived: boolean;
              version: number;
            }>(
              `UPDATE finance_category
                  SET name = $3, kind = $4, version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND id = $2 AND version = $5
                RETURNING id, workspace_id, name, kind, archived, version`,
              [scope.workspaceId, categoryId, nextName, nextKind, expectedVersion],
            )
            .catch((error: unknown) => {
              if (isUniqueViolation(error)) {
                throw new FinanceConflictError("Já existe uma categoria ativa com este nome.");
              }
              throw error;
            });
          const row = updated.rows[0];
          if (!row) throw new VersionConflictError(current.version);
          await this.recordCategoryAudit(client, scope, categoryId, "category.updated", {
            before: { name: current.name, kind: current.kind, archived: current.archived },
            after: { name: row.name, kind: row.kind, archived: row.archived },
          });
          return {
            statusCode: 200,
            response: { category: toCategoryView(row) } as unknown as JsonValue,
          };
        },
      }),
    );
    const response = result.response as unknown as { category: CategoryView };
    return { replayed: result.replayed, category: response.category };
  }

  async archiveCategory(
    scope: FinanceScope,
    categoryId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; category: CategoryView }> {
    return this.transitionCategory(scope, categoryId, "archive", idempotencyKey, expectedVersion);
  }

  async restoreCategory(
    scope: FinanceScope,
    categoryId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; category: CategoryView }> {
    return this.transitionCategory(scope, categoryId, "restore", idempotencyKey, expectedVersion);
  }

  private async transitionCategory(
    scope: FinanceScope,
    categoryId: string,
    action: "archive" | "restore",
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; category: CategoryView }> {
    assertFinanceCapability(scope, "finance.write");
    categoryTransitionSchema.parse({ confirm: true });
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/categories/${categoryId}/${action}`,
        key: idempotencyKey,
        request: { categoryId, expectedVersion, action },
        execute: async () => {
          const currentResult = await client.query<{
            id: string;
            workspace_id: string;
            name: string;
            kind: "income" | "expense" | "both";
            archived: boolean;
            version: number;
          }>(
            `SELECT id, workspace_id, name, kind, archived, version
               FROM finance_category
              WHERE workspace_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.workspaceId, categoryId],
          );
          const current = currentResult.rows[0];
          if (!current) throw new FinanceNotFoundError();
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (action === "restore")
            await assertCategoryNameAvailable(client, scope.workspaceId, current.name, categoryId);
          if (action === "archive" && current.archived) {
            throw new FinanceConflictError("A categoria já está arquivada.");
          }
          if (action === "restore" && !current.archived) {
            throw new FinanceConflictError("A categoria já está ativa.");
          }
          const archived = action === "archive";
          const updated = await client
            .query<{
              id: string;
              workspace_id: string;
              name: string;
              kind: "income" | "expense" | "both";
              archived: boolean;
              version: number;
            }>(
              `UPDATE finance_category
                  SET archived = $3, version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND id = $2 AND version = $4
                RETURNING id, workspace_id, name, kind, archived, version`,
              [scope.workspaceId, categoryId, archived, expectedVersion],
            )
            .catch((error: unknown) => {
              if (isUniqueViolation(error)) {
                throw new FinanceConflictError("Já existe uma categoria ativa com este nome.");
              }
              throw error;
            });
          const row = updated.rows[0];
          if (!row) throw new VersionConflictError(current.version);
          await this.recordCategoryAudit(client, scope, categoryId, `category.${action}`, {
            before: { name: current.name, kind: current.kind, archived: current.archived },
            after: { name: row.name, kind: row.kind, archived: row.archived },
          });
          return {
            statusCode: 200,
            response: { category: toCategoryView(row) } as unknown as JsonValue,
          };
        },
      }),
    );
    const response = result.response as unknown as { category: CategoryView };
    return { replayed: result.replayed, category: response.category };
  }

  async createCard(scope: FinanceScope, input: unknown, idempotencyKey: string) {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createCreditCardSchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/cards`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          if (parsed.limit && parsed.limit.currency !== currency) {
            throw new FinanceConflictError("O limite do cartão deve usar a moeda do espaço.");
          }
          const result = await client.query(
            `INSERT INTO credit_card (workspace_id, name, closing_day, due_day, holder, last_four, limit_minor, currency_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, workspace_id, name, closing_day, due_day, holder, last_four, limit_minor, currency_code, archived, version`,
            [
              scope.workspaceId,
              parsed.name,
              parsed.closingDay,
              parsed.dueDay,
              parsed.holder ?? null,
              parsed.lastFour ?? null,
              parsed.limit ? BigInt(parsed.limit.minor) : null,
              currency,
            ],
          );
          const row = result.rows[0];
          if (!row) throw new Error("card insert failed");
          return { statusCode: 201, response: toCreditCardView(row) as unknown as JsonValue };
        },
      }),
    );
  }

  async updateCard(
    scope: FinanceScope,
    cardId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; card: CreditCardView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = updateCreditCardSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:PATCH:/cards/${cardId}`,
        key: idempotencyKey,
        request: { cardId, expectedVersion, ...parsed },
        execute: async () => {
          const current = await lockCreditCard(client, scope.workspaceId, cardId);
          if (!current) throw new FinanceNotFoundError();
          if (current.version !== expectedVersion) {
            throw new VersionConflictError(current.version);
          }
          const changesClosingCycle =
            parsed.closingDay !== undefined && parsed.closingDay !== current.closing_day;
          const changesDueCycle = parsed.dueDay !== undefined && parsed.dueDay !== current.due_day;
          if (changesClosingCycle || changesDueCycle) {
            // Existing purchases retain the cycle dates that were persisted when
            // they were created. Changing the card rule while such a cycle is
            // open would make the next purchase recalculate against a different
            // rule and can create overlapping open invoices. Keep the operation
            // explicit: the user must close/resolve the cycle before changing
            // the rule.
            const blocking = await client.query<{ blocked: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                   FROM credit_statement s
                  WHERE s.workspace_id = $1 AND s.card_id = $2 AND s.state = 'open'
                    AND EXISTS (
                      SELECT 1
                        FROM finance_transaction t
                       WHERE t.workspace_id = s.workspace_id
                         AND t.statement_id = s.id
                         AND t.kind = 'expense'
                         AND t.state <> 'canceled'
                    )
               ) AS blocked`,
              [scope.workspaceId, cardId],
            );
            if (blocking.rows[0]?.blocked) {
              throw new FinanceConflictError(
                "Feche ou resolva a fatura aberta antes de alterar o ciclo do cartão.",
              );
            }
          }
          if (parsed.limit && parsed.limit.currency !== current.currency_code) {
            throw new FinanceConflictError("O limite do cartão deve usar a moeda do espaço.");
          }
          const updated = await client.query<CreditCardRow>(
            `UPDATE credit_card
                SET name = $3, closing_day = $4, due_day = $5, holder = $6, last_four = $7,
                    limit_minor = $8, version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $9
              RETURNING id, workspace_id, name, closing_day, due_day, holder, last_four,
                        limit_minor, currency_code, archived, version`,
            [
              scope.workspaceId,
              cardId,
              parsed.name ?? current.name,
              parsed.closingDay ?? current.closing_day,
              parsed.dueDay ?? current.due_day,
              parsed.holder === undefined ? current.holder : parsed.holder,
              parsed.lastFour === undefined ? current.last_four : parsed.lastFour,
              parsed.limit === undefined
                ? current.limit_minor
                : parsed.limit === null
                  ? null
                  : BigInt(parsed.limit.minor),
              expectedVersion,
            ],
          );
          const row = updated.rows[0];
          if (!row) throw new VersionConflictError(current.version);
          return { statusCode: 200, response: toCreditCardView(row) as unknown as JsonValue };
        },
      }),
    );
    return { replayed: result.replayed, card: result.response as unknown as CreditCardView };
  }

  async archiveCard(
    scope: FinanceScope,
    cardId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; card: CreditCardView }> {
    assertFinanceCapability(scope, "finance.write");
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/cards/${cardId}/archive`,
        key: idempotencyKey,
        request: { cardId, expectedVersion },
        execute: async () => {
          const current = await lockCreditCard(client, scope.workspaceId, cardId);
          if (!current) throw new FinanceNotFoundError();
          if (current.version !== expectedVersion) {
            throw new VersionConflictError(current.version);
          }
          if (!current.archived) {
            const blocking = await client.query<{ blocked: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                   FROM credit_statement
                  WHERE workspace_id = $1 AND card_id = $2 AND state <> 'canceled'
                    AND (state = 'open' OR total_minor > paid_minor)
               ) AS blocked`,
              [scope.workspaceId, cardId],
            );
            if (blocking.rows[0]?.blocked) {
              throw new FinanceConflictError(
                "Quite o saldo e feche ou transfira a fatura antes de arquivar o cartão.",
              );
            }
          }
          const updated = await client.query<CreditCardRow>(
            `UPDATE credit_card
                SET archived = true, version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $3
              RETURNING id, workspace_id, name, closing_day, due_day, holder, last_four,
                        limit_minor, currency_code, archived, version`,
            [scope.workspaceId, cardId, expectedVersion],
          );
          const row = updated.rows[0];
          if (!row) throw new VersionConflictError(current.version);
          return { statusCode: 200, response: toCreditCardView(row) as unknown as JsonValue };
        },
      }),
    );
    return { replayed: result.replayed, card: result.response as unknown as CreditCardView };
  }

  async createCardPurchase(scope: FinanceScope, input: unknown, idempotencyKey: string) {
    const parsed = createTransactionSchema.parse({
      ...(input as object),
      kind: "expense",
      state: "posted",
    });
    if (!parsed.cardId) throw new FinanceConflictError("Compra no cartão exige cartão.");
    return this.createTransaction(scope, parsed, idempotencyKey, "cards/:cardId/purchases");
  }

  async payStatement(
    scope: FinanceScope,
    statementId: string,
    input: unknown,
    idempotencyKey: string,
  ) {
    assertFinanceCapability(scope, "finance.write");
    const amountInput = input as {
      amount?: { currency: string; minor: string };
      allowCredit?: boolean;
      occurredOn?: string;
    };
    return this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/statements/${statementId}/payments`,
        key: idempotencyKey,
        request: input,
        execute: async () => {
          const statement = await client.query<{
            card_id: string;
            total_minor: string;
            paid_minor: string;
            currency_code: string;
            state: string;
            version: number;
          }>(
            `SELECT s.card_id, s.total_minor, s.paid_minor, c.currency_code, s.state, s.version FROM credit_statement s JOIN credit_card c ON c.id = s.card_id WHERE s.workspace_id = $1 AND s.id = $2 FOR UPDATE`,
            [scope.workspaceId, statementId],
          );
          const row = statement.rows[0];
          if (!row) throw new FinanceNotFoundError();
          if (row.state === "canceled") {
            throw new FinanceConflictError("Não é possível pagar uma fatura cancelada.");
          }
          if (amountInput.amount && amountInput.amount.currency !== row.currency_code)
            throw new FinanceConflictError("A moeda do pagamento difere da fatura.");
          const open = BigInt(row.total_minor) - BigInt(row.paid_minor);
          const amount = amountInput.amount ? BigInt(amountInput.amount.minor) : open;
          if (amount <= 0n || (!amountInput.allowCredit && amount > open))
            throw new FinanceConflictError("O pagamento excede o valor em aberto.");
          const wallet = await this.ensureAccount(
            client,
            scope.workspaceId,
            "wallet",
            "Carteira",
            row.currency_code,
          );
          const liability = await this.ensureAccount(
            client,
            scope.workspaceId,
            "card_liability",
            `Cartão ${row.card_id}`,
            row.currency_code,
          );
          const tx = await client.query<{ id: string }>(
            `INSERT INTO finance_transaction (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, posted_on, cash_settled_on, description, statement_id) VALUES ($1, 'transfer', 'posted', 'wallet', $2, $2, $3, $4, now(), now(), 'Pagamento de fatura', $5) RETURNING id`,
            [
              scope.workspaceId,
              amount,
              row.currency_code,
              amountInput.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId)),
              statementId,
            ],
          );
          const txId = tx.rows[0]?.id;
          if (!txId) throw new Error("transaction insert failed");
          await this.publishEvent(
            client,
            scope,
            txId,
            "statement.payment.v1",
            row.currency_code,
            canonicalCardPaymentPostings({
              amount: Money.fromTrusted(amount, row.currency_code as never),
              wallet,
              cardLiability: liability,
            }).map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
            amountInput.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId)),
          );
          await client.query(
            `INSERT INTO card_payment (workspace_id, statement_id, transaction_id, amount_minor) VALUES ($1, $2, $3, $4)`,
            [scope.workspaceId, statementId, txId, amount],
          );
          const paid = BigInt(row.paid_minor) + amount;
          await client.query(
            `UPDATE credit_statement SET paid_minor = $1, state = CASE WHEN $1 >= total_minor THEN 'paid' ELSE 'partially_paid' END, version = version + 1, updated_at = now() WHERE id = $2`,
            [paid, statementId],
          );
          await this.recordTransactionAudit(client, scope, txId, "transaction.created", null, {
            kind: "transfer",
            state: "posted",
            categoryId: null,
            cardId: null,
            statementId,
            version: 0,
          });
          return {
            statusCode: 201,
            response: {
              transactionId: txId,
              statementId,
              amount: { currency: row.currency_code, minor: amount.toString() },
            } as JsonValue,
          };
        },
      }),
    );
  }

  async createInstallmentPlan(scope: FinanceScope, input: unknown, idempotencyKey: string) {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createInstallmentPlanSchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/installments`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          if (parsed.total.currency !== currency) {
            throw new FinanceConflictError("O parcelamento deve usar a moeda do espaço.");
          }
          const parts = distributeInstallments(
            Money.fromTrusted(BigInt(parsed.total.minor), parsed.total.currency as never),
            parsed.count,
          );
          const plan = await client.query<{ id: string }>(
            `INSERT INTO installment_plan (workspace_id, total_minor, count, first_due_on) VALUES ($1, $2, $3, $4) RETURNING id`,
            [scope.workspaceId, BigInt(parsed.total.minor), parsed.count, parsed.firstDueOn],
          );
          const planId = plan.rows[0]?.id;
          if (!planId) throw new Error("installment plan insert failed");
          const dates = generateRecurrenceDates("monthly", parsed.firstDueOn, parsed.count);
          const installments: Array<{
            id: string;
            number: number;
            amount: { currency: string; minor: string };
            dueOn: string;
          }> = [];
          for (const [index, part] of parts.entries()) {
            const transaction = await client.query<{ id: string }>(
              `INSERT INTO finance_transaction (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, due_on, description, installment_plan_id, installment_number) VALUES ($1, 'expense', 'planned', 'wallet', $2, 0, $3, $4, $4, $5, $6, $7) RETURNING id`,
              [
                scope.workspaceId,
                part.minor,
                parsed.total.currency,
                dates[index],
                parsed.description,
                planId,
                index + 1,
              ],
            );
            const transactionId = transaction.rows[0]?.id;
            if (!transactionId) throw new Error("installment transaction insert failed");
            const installment = await client.query<{ id: string }>(
              `INSERT INTO installment (workspace_id, plan_id, transaction_id, number, amount_minor, due_on) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [scope.workspaceId, planId, transactionId, index + 1, part.minor, dates[index]],
            );
            const installmentId = installment.rows[0]?.id;
            if (!installmentId) throw new Error("installment insert failed");
            await this.recordTransactionAudit(
              client,
              scope,
              transactionId,
              "transaction.created",
              null,
              {
                kind: "expense",
                state: "planned",
                categoryId: null,
                cardId: null,
                statementId: null,
                version: 0,
              },
            );
            installments.push({
              id: installmentId,
              number: index + 1,
              amount: part.toJSON(),
              dueOn: dates[index] ?? parsed.firstDueOn,
            });
          }
          return {
            statusCode: 201,
            response: {
              id: planId,
              total: parsed.total,
              count: parsed.count,
              installments,
            } as JsonValue,
          };
        },
      }),
    );
  }

  async createRecurrence(
    scope: FinanceScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; response: RecurrenceCreateResponse }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createRecurrenceSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/recurrences`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          if (
            parsed.amount.currency !== currency ||
            (parsed.estimatedAmount && parsed.estimatedAmount.currency !== currency)
          ) {
            throw new FinanceConflictError("A recorrência deve usar a moeda do espaço.");
          }
          const today = await this.workspaceToday(client, scope.workspaceId);
          const dates = recurrenceDatesThrough(
            {
              frequency: parsed.frequency,
              interval: parsed.interval,
              start_on: parsed.startOn,
              end_on: parsed.endOn ?? null,
              max_occurrences: parsed.maxOccurrences ?? null,
              paused_on: null,
            },
            today,
          );
          const rule = await client.query<{ id: string }>(
            `INSERT INTO recurrence_rule
              (workspace_id, kind, amount_minor, frequency, interval, start_on, end_on,
               max_occurrences, variable, estimated_minor, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
              scope.workspaceId,
              parsed.kind,
              BigInt(parsed.amount.minor),
              parsed.frequency,
              parsed.interval,
              parsed.startOn,
              parsed.endOn ?? null,
              parsed.maxOccurrences ?? null,
              parsed.variable,
              parsed.estimatedAmount ? BigInt(parsed.estimatedAmount.minor) : null,
              parsed.description,
            ],
          );
          const recurrenceId = rule.rows[0]?.id;
          if (!recurrenceId) throw new Error("recurrence rule insert failed");
          const ruleData: RecurrenceRuleRow = {
            id: recurrenceId,
            workspace_id: scope.workspaceId,
            kind: parsed.kind,
            amount_minor: parsed.amount.minor,
            frequency: parsed.frequency,
            interval: parsed.interval,
            start_on: parsed.startOn,
            end_on: parsed.endOn ?? null,
            max_occurrences: parsed.maxOccurrences ?? null,
            variable: parsed.variable,
            estimated_minor: parsed.estimatedAmount?.minor ?? null,
            description: parsed.description,
            status: "active",
            paused_on: null,
            version: 0,
          };
          for (const date of dates) {
            await this.materializeRecurrenceOccurrence(client, scope, ruleData, date, currency);
          }
          await this.enqueueRecurrenceExpansion(
            client,
            scope.workspaceId,
            today,
            scope.correlationId,
          );
          return {
            statusCode: 201,
            response: {
              id: recurrenceId,
              frequency: parsed.frequency,
              occurrences: [...dates],
            } as unknown as JsonValue,
          };
        },
      }),
    );
    return {
      replayed: result.replayed,
      response: result.response as unknown as RecurrenceCreateResponse,
    };
  }

  async transitionRecurrence(
    scope: FinanceScope,
    recurrenceId: string,
    action: "pause" | "resume",
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; recurrence: RecurrenceView }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = recurrenceTransitionSchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) => {
      const result = await executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/recurrences/${recurrenceId}/${action}`,
        key: idempotencyKey,
        request: { action, recurrenceId, parsed, expectedVersion },
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          const current = await client.query<RecurrenceRuleRow>(
            `SELECT id, workspace_id, kind, amount_minor, frequency, interval,
                    start_on::text AS start_on, end_on::text AS end_on,
                    max_occurrences, variable, estimated_minor, description,
                    status, paused_on::text AS paused_on, version
               FROM recurrence_rule
              WHERE workspace_id = $1 AND id = $2 AND status = 'active'
              FOR UPDATE`,
            [scope.workspaceId, recurrenceId],
          );
          const row = current.rows[0];
          if (!row) throw new FinanceNotFoundError();
          if (row.version !== expectedVersion) throw new VersionConflictError(row.version);
          if (action === "pause") {
            if (row.paused_on) {
              throw new FinanceConflictError("A recorrência já está pausada.");
            }
            const effectiveOn =
              parsed.effectiveOn ?? (await this.workspaceToday(client, scope.workspaceId));
            if (effectiveOn < row.start_on) {
              throw new FinanceConflictError("A pausa não pode começar antes da recorrência.");
            }
            await client.query(
              `UPDATE recurrence_rule
                  SET paused_on = $1, version = version + 1, updated_at = now()
                WHERE workspace_id = $2 AND id = $3 AND version = $4`,
              [effectiveOn, scope.workspaceId, recurrenceId, expectedVersion],
            );
            const canceled = await client.query<{
              id: string;
              kind: "income" | "expense";
              state: string;
              version: number;
            }>(
              `UPDATE finance_transaction
                  SET state = 'canceled', version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND recurrence_id = $2
                  AND occurred_on >= $3 AND state = 'planned'
                RETURNING id, kind, state, version`,
              [scope.workspaceId, recurrenceId, effectiveOn],
            );
            for (const transaction of canceled.rows) {
              await this.recordTransactionAudit(
                client,
                scope,
                transaction.id,
                "transaction.canceled",
                { kind: transaction.kind, state: "planned", version: transaction.version - 1 },
                { kind: transaction.kind, state: transaction.state, version: transaction.version },
              );
            }
          } else {
            if (!row.paused_on) {
              throw new FinanceConflictError("A recorrência já está ativa.");
            }
            if (parsed.effectiveOn) {
              throw new FinanceConflictError("A retomada não aceita data efetiva.");
            }
            await client.query(
              `UPDATE recurrence_rule
                  SET paused_on = NULL, version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND id = $2 AND version = $3`,
              [scope.workspaceId, recurrenceId, expectedVersion],
            );
          }
          const updated = await client.query<RecurrenceRuleRow>(
            `SELECT id, workspace_id, kind, amount_minor, frequency, interval,
                    start_on::text AS start_on, end_on::text AS end_on,
                    max_occurrences, variable, estimated_minor, description,
                    status, paused_on::text AS paused_on, version
               FROM recurrence_rule
              WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
            [scope.workspaceId, recurrenceId],
          );
          const next = updated.rows[0];
          if (!next) throw new Error("recurrence transition lost its row");
          return {
            statusCode: 200,
            response: toRecurrenceView(next, currency) as unknown as JsonValue,
          };
        },
      });
      return {
        replayed: result.replayed,
        recurrence: result.response as unknown as RecurrenceView,
      };
    });
  }

  /** Builds the durable system worker used by the recurrence process. */
  createRecurrenceWorker(): PostgresJobWorker {
    return new PostgresJobWorker(
      this.pool,
      new Map([
        [
          "recurrence.expand:1",
          async (job: JobRecord, context) => {
            const payload = parseRecurrenceJobPayload(job.payload);
            if (payload.workspaceId !== job.workspaceId)
              throw new Error("recurrence job scope mismatch");
            const parsedToday = parseLocalDate(payload.asOf);
            if (!parsedToday.ok) throw new Error("recurrence job has an invalid civil date");
            await context.runBatch(async ({ client, beforeTransition }) => {
              const currency = await this.workspaceCurrency(client, payload.workspaceId);
              const rules = await client.query<RecurrenceRuleRow>(
                `SELECT id, workspace_id, kind, amount_minor, frequency, interval,
                        start_on::text AS start_on, end_on::text AS end_on,
                        max_occurrences, variable, estimated_minor, description,
                        status, paused_on::text AS paused_on, version
                   FROM recurrence_rule
                  WHERE workspace_id = $1 AND status = 'active'
                  ORDER BY id
                  FOR UPDATE`,
                [payload.workspaceId],
              );
              const jobScope: FinanceScope = {
                workspaceId: payload.workspaceId,
                actorId: "system",
                role: "owner",
                correlationId: job.correlationId,
              };
              for (const rule of rules.rows) {
                await beforeTransition();
                const dates = recurrenceDatesThrough(rule, parsedToday.value);
                for (const date of dates) {
                  await this.materializeRecurrenceOccurrence(
                    client,
                    jobScope,
                    rule,
                    date,
                    currency,
                    { actorId: null, origin: "job" },
                  );
                }
              }
            });
          },
        ],
      ]),
      {
        applicationRole: this.applicationRole,
      },
    );
  }

  /** Enqueues one idempotent expansion job per workspace and local civil day. */
  async scheduleRecurrenceExpansions(at = this.clock.now()): Promise<number> {
    const workspaces = await this.listActiveRecurrenceWorkspaces();
    let scheduled = 0;
    for (const row of workspaces.rows) {
      await withUnitOfWork(
        this.pool,
        { workspaceId: row.workspace_id, applicationRole: this.applicationRole },
        async ({ client }) => {
          const today = await this.workspaceToday(client, row.workspace_id, at);
          const result = await this.enqueueRecurrenceExpansion(
            client,
            row.workspace_id,
            today,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            at,
          );
          scheduled += result;
        },
      );
    }
    return scheduled;
  }

  /**
   * Lists active recurrence workspaces under the read-only system RLS policy.
   * This is deliberately independent from `job`: old rules may have no seed
   * job after an interrupted migration or a restored database.
   */
  private async listActiveRecurrenceWorkspaces(): Promise<{ rows: { workspace_id: string }[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.applicationRole)) {
        throw new Error("Invalid PostgreSQL role identifier");
      }
      await client.query(`SET LOCAL ROLE "${this.applicationRole}"`);
      await client.query(
        `SELECT set_config('app.workspace_id', '', true),
                set_config('app.actor_id', 'system', true),
                set_config('app.correlation_id', '', true)`,
      );
      const result = await client.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id
           FROM recurrence_rule
          WHERE status = 'active'
          ORDER BY workspace_id`,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async enqueueRecurrenceExpansion(
    client: PgPoolClient,
    workspaceId: string,
    asOf: string,
    correlationId: string,
    availableAt = this.clock.now(),
  ): Promise<number> {
    const result = await client.query(
      `INSERT INTO job
        (job_type, job_version, workspace_id, actor_id, required_capability,
         idempotency_key, payload, available_at, correlation_id)
       VALUES ('recurrence.expand', 1, $1, NULL, 'system.recurrence', $2, $3::jsonb, $4, $5)
       ON CONFLICT (job_type, idempotency_key) DO NOTHING`,
      [
        workspaceId,
        `recurrence-expand:${workspaceId}:${asOf}`,
        JSON.stringify({ workspaceId, asOf } satisfies RecurrenceJobPayload),
        availableAt,
        correlationId,
      ],
    );
    return result.rowCount ?? 0;
  }

  private async materializeRecurrenceOccurrence(
    client: PgPoolClient,
    scope: FinanceScope,
    rule: RecurrenceRuleRow,
    date: string,
    currency: string,
    auditOptions: { actorId: string | null; origin: "api" | "job" } = {
      actorId: scope.actorId,
      origin: "api",
    },
  ): Promise<string> {
    const transaction = await client.query<{ id: string }>(
      `INSERT INTO finance_transaction
        (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
         occurred_on, due_on, description, recurrence_id)
       VALUES ($1, $2, 'planned', 'wallet', $3, 0, $4, $5, $5, $6, $7)
       ON CONFLICT (workspace_id, recurrence_id, occurred_on)
         WHERE recurrence_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        rule.workspace_id,
        rule.kind,
        BigInt(rule.amount_minor),
        currency,
        date,
        rule.description,
        rule.id,
      ],
    );
    const transactionId =
      transaction.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM finance_transaction
            WHERE workspace_id = $1 AND recurrence_id = $2 AND occurred_on = $3`,
          [rule.workspace_id, rule.id, date],
        )
      ).rows[0]?.id;
    if (!transactionId) throw new Error("recurrence transaction insert failed");
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO recurrence_occurrence
        (workspace_id, recurrence_id, transaction_id, occurrence_on)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (recurrence_id, occurrence_on) DO NOTHING
       RETURNING id`,
      [rule.workspace_id, rule.id, transactionId, date],
    );
    if (transaction.rows[0]?.id && occurrence.rows[0]?.id) {
      await this.recordTransactionAudit(
        client,
        scope,
        transactionId,
        "transaction.created",
        null,
        {
          kind: rule.kind,
          state: "planned",
          categoryId: null,
          cardId: null,
          statementId: null,
          version: 0,
        },
        auditOptions,
      );
    }
    return transactionId;
  }

  private async insertTransaction(
    client: PgPoolClient,
    scope: FinanceScope,
    input: CreateTransactionInput,
  ): Promise<TransactionView> {
    const occurredOn = input.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId));
    const currency = input.amount.currency;
    const workspaceCurrency = await this.workspaceCurrency(client, scope.workspaceId);
    if (currency !== workspaceCurrency) {
      throw new FinanceConflictError("A moeda da transação difere da moeda do espaço.");
    }
    if (!parseLocalDate(occurredOn).ok || (input.dueOn && !parseLocalDate(input.dueOn).ok)) {
      throw new FinanceConflictError("A data civil informada não existe.");
    }
    if (input.kind === "transfer")
      throw new FinanceConflictError("Uma transferência exige uma operação de origem e destino.");
    if (input.kind === "adjustment")
      throw new FinanceConflictError(
        "Ajustes exigem o comando de conferência com motivo e saldo observado.",
      );
    if (input.cardId && input.kind !== "expense")
      throw new FinanceConflictError("Somente despesas podem usar cartão.");
    if (input.categoryId) {
      const category = await client.query<{
        kind: "income" | "expense" | "both";
        archived: boolean;
      }>(
        `SELECT kind, archived
           FROM finance_category
          WHERE workspace_id = $1 AND id = $2
          FOR SHARE`,
        [scope.workspaceId, input.categoryId],
      );
      const categoryRow = category.rows[0];
      if (!categoryRow || categoryRow.archived) {
        throw new FinanceConflictError("A categoria não está disponível para novos lançamentos.");
      }
      if (
        (input.kind === "income" && !["income", "both"].includes(categoryRow.kind)) ||
        (input.kind === "expense" && !["expense", "both"].includes(categoryRow.kind))
      ) {
        throw new FinanceConflictError("A categoria não é compatível com o tipo da transação.");
      }
    }
    if (input.cardId) {
      const card = await client.query<{ id: string; currency_code: string; archived: boolean }>(
        `SELECT id, currency_code, archived FROM credit_card WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [scope.workspaceId, input.cardId],
      );
      const cardRow = card.rows[0];
      if (!cardRow || cardRow.archived) throw new FinanceNotFoundError();
      if (cardRow.currency_code !== currency)
        throw new FinanceConflictError("A moeda do cartão difere da carteira.");
    }
    const result = await client.query<TransactionRow>(
      `INSERT INTO finance_transaction (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, cash_settled_on, description, category_id, card_id)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 = 'posted' THEN $5 ELSE 0 END, $6, $7, $8, CASE WHEN $3 = 'posted' THEN now() ELSE null END, CASE WHEN $3 = 'posted' AND $4 = 'wallet' THEN now() ELSE null END, $9, $10, $11)
       RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version`,
      [
        scope.workspaceId,
        input.kind,
        input.state,
        input.cardId ? "card" : "wallet",
        BigInt(input.amount.minor),
        currency,
        occurredOn,
        input.dueOn ?? null,
        input.description,
        input.categoryId ?? null,
        input.cardId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("transaction insert failed");
    if (input.state === "posted") {
      await this.publishTransaction(client, scope, row, BigInt(input.amount.minor));
      const refreshed = await client.query<TransactionRow>(
        `SELECT id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version FROM finance_transaction WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, row.id],
      );
      const value = refreshed.rows[0] ?? row;
      await this.recordTransactionAudit(
        client,
        scope,
        row.id,
        "transaction.created",
        null,
        transactionAuditSnapshot(value),
      );
      return toTransactionView(value);
    }
    await this.recordTransactionAudit(
      client,
      scope,
      row.id,
      "transaction.created",
      null,
      transactionAuditSnapshot(row),
    );
    return toTransactionView(row);
  }

  private async publishTransaction(
    client: PgPoolClient,
    scope: FinanceScope,
    row: TransactionRow,
    amount: bigint,
    occurredOn = row.occurred_on,
    eventType = "transaction.posted.v1",
  ) {
    const wallet = await this.ensureAccount(
      client,
      scope.workspaceId,
      "wallet",
      "Carteira",
      row.currency_code,
    );
    if (row.card_id) {
      const liability = await this.ensureAccount(
        client,
        scope.workspaceId,
        "card_liability",
        `Cartão ${row.card_id}`,
        row.currency_code,
      );
      const postings = canonicalTransactionPostings({
        kind: "expense",
        instrument: "card",
        amount: Money.fromTrusted(amount, row.currency_code as never),
        accounts: {
          wallet,
          income: "unused-income",
          expense: await this.ensureAccount(
            client,
            scope.workspaceId,
            "expense",
            "Despesas",
            row.currency_code,
          ),
          adjustment: "unused-adjustment",
          cardLiability: liability,
        },
      });
      await this.publishEvent(
        client,
        scope,
        row.id,
        eventType,
        row.currency_code,
        postings.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
        occurredOn,
      );
      await this.ensureStatementForPurchase(
        client,
        scope.workspaceId,
        row.id,
        row.card_id,
        row.occurred_on,
        amount,
      );
      return;
    }
    const accountKind =
      row.kind === "income" ? "income" : row.kind === "expense" ? "expense" : "adjustment";
    const account = await this.ensureAccount(
      client,
      scope.workspaceId,
      accountKind,
      accountKind === "income" ? "Receitas" : accountKind === "expense" ? "Despesas" : "Ajustes",
      row.currency_code,
    );
    const entries = canonicalTransactionPostings({
      kind: row.kind as "income" | "expense" | "adjustment",
      instrument: "wallet",
      amount: Money.fromTrusted(amount, row.currency_code as never),
      accounts: {
        wallet,
        income: accountKind === "income" ? account : "unused-income",
        expense: accountKind === "expense" ? account : "unused-expense",
        adjustment: accountKind === "adjustment" ? account : "unused-adjustment",
      },
    });
    await this.publishEvent(
      client,
      scope,
      row.id,
      eventType,
      row.currency_code,
      entries.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
      occurredOn,
    );
  }

  private async publishEvent(
    client: PgPoolClient,
    scope: FinanceScope,
    transactionId: string,
    eventType: string,
    currency: string,
    entries: readonly { accountId: string; amount: bigint }[],
    occurredOn: string,
  ) {
    const postings = entries.map((entry) => ({
      accountId: entry.accountId,
      amount: Money.fromTrusted(entry.amount, currency as never),
    }));
    assertBalancedLedgerEvent(postings);
    const event = await client.query<{ id: string }>(
      `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at) VALUES ($1, $2, $3, $4, 'published', $5, now()) RETURNING id`,
      [scope.workspaceId, transactionId, eventType, currency, occurredOn],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("ledger event insert failed");
    for (const entry of entries)
      await client.query(
        `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
        [scope.workspaceId, eventId, entry.accountId, currency, entry.amount],
      );
  }

  private async ensureStatementForPurchase(
    client: PgPoolClient,
    workspaceId: string,
    transactionId: string,
    cardId: string,
    occurredOn: string,
    amount: bigint,
  ) {
    const card = await client.query<{ closing_day: number; due_day: number }>(
      `SELECT closing_day, due_day FROM credit_card WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, cardId],
    );
    const cardRow = card.rows[0];
    if (!cardRow) throw new FinanceNotFoundError();
    const dates = calculateStatementDates(
      occurredOn,
      cardRow.closing_day,
      cardRow.due_day,
      "purchase",
    );
    await client.query(
      `INSERT INTO credit_statement (workspace_id, card_id, period_start, closing_on, due_on, state, total_minor)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)
       ON CONFLICT (card_id, closing_on) DO NOTHING`,
      [workspaceId, cardId, dates.periodStart, dates.closingOn, dates.dueOn, amount],
    );
    const statement = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM credit_statement WHERE workspace_id = $1 AND card_id = $2 AND closing_on = $3 FOR UPDATE`,
      [workspaceId, cardId, dates.closingOn],
    );
    const statementRow = statement.rows[0];
    if (!statementRow) throw new FinanceNotFoundError();
    if (statementRow.state !== "open") {
      throw new FinanceConflictError(
        "A fatura fechada ou paga não aceita compras silenciosamente; use um ajuste explícito.",
      );
    }
    await client.query(
      `UPDATE credit_statement SET total_minor = total_minor + $1, version = version + 1, updated_at = now()
        WHERE workspace_id = $2 AND id = $3 AND state = 'open'`,
      [amount, workspaceId, statementRow.id],
    );
    await client.query(
      `UPDATE finance_transaction SET statement_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [statementRow.id, workspaceId, transactionId],
    );
  }

  private async ensureAccount(
    client: PgPoolClient,
    workspaceId: string,
    kind: string,
    name: string,
    currency: string,
  ): Promise<string> {
    return ensureFinancialAccount(client, workspaceId, kind, name, currency);
  }

  private async walletAdjustmentAccounts(
    client: PgPoolClient,
    workspaceId: string,
    currency: string,
  ): Promise<{ wallet: string; adjustment: string }> {
    return {
      wallet: await this.ensureAccount(client, workspaceId, "wallet", "Carteira", currency),
      adjustment: await this.ensureAccount(client, workspaceId, "adjustment", "Ajustes", currency),
    };
  }

  private async readWallet(
    client: PgPoolClient,
    workspaceId: string,
    lock: "share" | "update",
  ): Promise<WalletView> {
    const account = await client.query<{ id: string; currency_code: string; version: number }>(
      `SELECT id, currency_code, version
         FROM financial_account
        WHERE workspace_id = $1 AND kind = 'wallet' AND name = 'Carteira'
        FOR ${lock === "update" ? "UPDATE" : "SHARE"}`,
      [workspaceId],
    );
    const row = account.rows[0];
    if (!row) throw new FinanceNotFoundError();
    const today = await this.workspaceToday(client, workspaceId);
    const balance = await client.query<{ balance_minor: string | bigint }>(
      `SELECT coalesce(sum(entry.amount_minor), 0)::bigint AS balance_minor
         FROM ledger_entry entry
         JOIN ledger_event event
           ON event.workspace_id = entry.workspace_id AND event.id = entry.event_id
        WHERE entry.workspace_id = $1
          AND entry.account_id = $2
          AND event.status = 'published'
          AND event.occurred_on <= $3::date`,
      [workspaceId, row.id, today],
    );
    return {
      workspaceId,
      balance: {
        currency: row.currency_code,
        minor: (balance.rows[0]?.balance_minor ?? 0n).toString(),
      },
      version: row.version,
    };
  }

  private async getLoanRow(
    client: PgPoolClient,
    workspaceId: string,
    loanId: string,
  ): Promise<LoanRow | null> {
    const result = await client.query<LoanRow>(
      `SELECT id, workspace_id, direction, counterparty, principal_minor, paid_minor,
              currency_code, occurred_on::text AS occurred_on, due_on::text AS due_on,
              principal_event_id, status, version
         FROM loan_contract
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, loanId],
    );
    return result.rows[0] ?? null;
  }

  private async publishLoanEvent(
    client: PgPoolClient,
    scope: FinanceScope,
    eventId: string,
    eventType: string,
    currency: string,
    entries: readonly { accountId: string; amount: bigint }[],
    occurredOn: string,
  ): Promise<void> {
    const postings = entries.map((entry) => ({
      accountId: entry.accountId,
      amount: Money.fromTrusted(entry.amount, currency as never),
    }));
    assertBalancedLedgerEvent(postings);
    await client.query(
      `INSERT INTO ledger_event
        (id, workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at)
       VALUES ($1, $2, NULL, $3, $4, 'published', $5, now())`,
      [eventId, scope.workspaceId, eventType, currency, occurredOn],
    );
    for (const entry of entries) {
      await client.query(
        `INSERT INTO ledger_entry
          (workspace_id, event_id, account_id, currency_code, amount_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope.workspaceId, eventId, entry.accountId, currency, entry.amount],
      );
    }
  }

  private async recordLoanAudit(
    client: PgPoolClient,
    scope: FinanceScope,
    loanId: string,
    action: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    const redactedBefore = redactFinanceAuditSnapshot(before);
    const redactedAfter = redactFinanceAuditSnapshot(after);
    await client.query(
      `INSERT INTO audit_event
        (category, action, actor_id, workspace_id, target_type, target_id,
         origin, correlation_id, result, before_redacted, after_redacted)
       VALUES ('finance', $1, $2, $3, 'loan_contract', $4, 'api', $5, 'success', $6::jsonb, $7::jsonb)`,
      [
        action,
        scope.actorId,
        scope.workspaceId,
        loanId,
        scope.correlationId,
        redactedBefore ? JSON.stringify(redactedBefore) : null,
        redactedAfter ? JSON.stringify(redactedAfter) : null,
      ],
    );
  }

  private async recordStatementAudit(
    client: PgPoolClient,
    scope: FinanceScope,
    statementId: string,
    action: "statement.closed" | "statement.reopened",
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
         (category, action, actor_id, workspace_id, target_type, target_id,
          origin, correlation_id, result)
       VALUES ('finance', $1, $2, $3, 'credit_statement', $4, 'api', $5, 'success')`,
      [action, scope.actorId, scope.workspaceId, statementId, scope.correlationId],
    );
  }

  private async recordTransactionAudit(
    client: PgPoolClient,
    scope: FinanceScope,
    transactionId: string,
    action: string,
    before: Record<string, unknown> | null = null,
    after: Record<string, unknown> | null = null,
    options: { actorId?: string | null; origin?: "api" | "job" } = {},
  ): Promise<void> {
    const redactedBefore = redactFinanceAuditSnapshot(before);
    const redactedAfter = redactFinanceAuditSnapshot(after);
    await client.query(
      `INSERT INTO audit_event
         (category, action, actor_id, workspace_id, target_type, target_id,
          origin, correlation_id, result, before_redacted, after_redacted)
       VALUES ('finance', $1, $2, $3, 'finance_transaction', $4, $5, $6, 'success', $7::jsonb, $8::jsonb)`,
      [
        action,
        options.actorId === undefined ? scope.actorId : options.actorId,
        scope.workspaceId,
        transactionId,
        options.origin ?? "api",
        scope.correlationId,
        redactedBefore ? JSON.stringify(redactedBefore) : null,
        redactedAfter ? JSON.stringify(redactedAfter) : null,
      ],
    );
  }

  private async recordCategoryAudit(
    client: PgPoolClient,
    scope: FinanceScope,
    categoryId: string,
    action: string,
    snapshots: { before: Record<string, unknown>; after: Record<string, unknown> },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
         (category, action, actor_id, workspace_id, target_type, target_id,
          origin, correlation_id, result, before_redacted, after_redacted)
       VALUES ('finance', $1, $2, $3, 'finance_category', $4, 'api', $5, 'success', $6::jsonb, $7::jsonb)`,
      [
        action,
        scope.actorId,
        scope.workspaceId,
        categoryId,
        scope.correlationId,
        JSON.stringify(snapshots.before),
        JSON.stringify(snapshots.after),
      ],
    );
  }

  private async workspaceCurrency(client: PgPoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ currency_code: string }>(
      `SELECT p.currency_code
         FROM workspace_preference p
         JOIN workspace w ON w.id = p.workspace_id
        WHERE p.workspace_id = $1
        FOR UPDATE OF w, p`,
      [workspaceId],
    );
    return result.rows[0]?.currency_code ?? "BRL";
  }

  private async workspaceToday(
    client: PgPoolClient,
    workspaceId: string,
    at = this.clock.now(),
  ): Promise<string> {
    const result = await client.query<{ timezone: string }>(
      `SELECT timezone FROM workspace_preference WHERE workspace_id = $1`,
      [workspaceId],
    );
    const timezone = result.rows[0]?.timezone ?? "UTC";
    try {
      const parsedTimeZone = parseTimeZone(timezone);
      if (!parsedTimeZone.ok) throw new Error("invalid time zone");
      const date = todayInTimeZone(fixedClock(at), parsedTimeZone.value);
      if (!date.ok) throw new Error("invalid local date");
      return date.value;
    } catch {
      throw new FinanceConflictError("O fuso horário do espaço é inválido.");
    }
  }

  private async mutateTransaction(
    scope: FinanceScope,
    id: string,
    key: string,
    expectedVersion: number | undefined,
    command: string,
    request: unknown = { id, expectedVersion },
    callback: (client: PgPoolClient, row: TransactionRow) => Promise<TransactionView>,
  ): Promise<TransactionView> {
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/${command}/${id}`,
        key,
        request,
        execute: async () => {
          const current = await client.query<TransactionRow>(
            `SELECT id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version FROM finance_transaction WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
            [scope.workspaceId, id],
          );
          const row = current.rows[0];
          if (!row) throw new FinanceNotFoundError();
          if (expectedVersion !== undefined && row.version !== expectedVersion)
            throw new VersionConflictError(row.version);
          const value = await callback(client, row);
          return { statusCode: 200, response: value as unknown as JsonValue };
        },
      }),
    );
    return result.response as unknown as TransactionView;
  }

  private async withScopedClient<T>(
    scope: FinanceScope,
    callback: (client: PgPoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setFinanceScope(client, scope, this.applicationRole);
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private withUnitOfWork<T>(
    scope: FinanceScope,
    callback: (context: { client: PgPoolClient }) => Promise<T>,
  ): Promise<T> {
    return withUnitOfWork(this.pool, this.databaseScope(scope), callback);
  }

  private databaseScope(scope: FinanceScope) {
    return { ...scope, applicationRole: this.applicationRole };
  }
}

export interface InitialWalletMaterializationInput {
  workspaceId: string;
  actorId: string | null;
  correlationId: string;
  origin: "api" | "system";
  now: Date;
}

/**
 * Converts the onboarding preference into an immutable opening event once.
 * The preference row lock is the natural idempotency boundary for legacy and
 * concurrent first reads; onboarding calls the same helper inside its UoW.
 */
export async function materializeInitialWalletBalance(
  client: PgPoolClient,
  input: InitialWalletMaterializationInput,
): Promise<string | null> {
  const preference = await client.query<{
    initial_balance_minor: string | bigint;
    initial_balance_materialized_at: Date | string | null;
    initial_balance_transaction_id: string | null;
    currency_code: string;
    timezone: string;
  }>(
    `SELECT initial_balance_minor, initial_balance_materialized_at,
            initial_balance_transaction_id, currency_code, timezone
       FROM workspace_preference
      WHERE workspace_id = $1
      FOR UPDATE`,
    [input.workspaceId],
  );
  const row = preference.rows[0];
  if (!row) throw new FinanceNotFoundError();
  if (row.initial_balance_materialized_at) return row.initial_balance_transaction_id;
  const initialMinor = BigInt(row.initial_balance_minor);
  if (initialMinor < 0n) {
    throw new FinanceConflictError("O saldo inicial pendente é inválido.");
  }
  const wallet = await ensureFinancialAccount(
    client,
    input.workspaceId,
    "wallet",
    "Carteira",
    row.currency_code,
  );
  if (initialMinor === 0n) {
    await client.query(
      `UPDATE workspace_preference
          SET initial_balance_materialized_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND initial_balance_materialized_at IS NULL`,
      [input.workspaceId],
    );
    return null;
  }
  const occurredOn = civilToday(input.now, row.timezone);
  const transaction = await client.query<TransactionRow>(
    `INSERT INTO finance_transaction
      (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code,
       occurred_on, due_on, posted_on, cash_settled_on, description, category_id, card_id,
       recurrence_id, installment_plan_id)
     VALUES ($1, 'adjustment', 'posted', 'wallet', $2, $2, $3, $4, NULL, now(), now(),
             'Saldo inicial', NULL, NULL, NULL, NULL)
     RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code,
               occurred_on::text AS occurred_on, due_on::text AS due_on, posted_on,
               description, category_id, card_id, statement_id,
               recurrence_id, installment_plan_id, version`,
    [input.workspaceId, initialMinor, row.currency_code, occurredOn],
  );
  const transactionRow = transaction.rows[0];
  if (!transactionRow) throw new Error("initial balance transaction insert failed");
  const adjustment = await ensureFinancialAccount(
    client,
    input.workspaceId,
    "adjustment",
    "Ajustes",
    row.currency_code,
  );
  const postings = canonicalWalletAdjustmentPostings({
    delta: Money.fromTrusted(initialMinor, row.currency_code as never),
    accounts: { wallet, adjustment },
  });
  assertBalancedLedgerEvent(postings);
  const event = await client.query<{ id: string }>(
    `INSERT INTO ledger_event
      (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at)
     VALUES ($1, $2, 'wallet.opening_balance.v1', $3, 'published', $4, now())
     RETURNING id`,
    [input.workspaceId, transactionRow.id, row.currency_code, occurredOn],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("initial balance ledger event insert failed");
  for (const posting of postings) {
    await client.query(
      `INSERT INTO ledger_entry
        (workspace_id, event_id, account_id, currency_code, amount_minor)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.workspaceId, eventId, posting.accountId, row.currency_code, posting.amount.minor],
    );
  }
  await client.query(
    `INSERT INTO audit_event
      (category, action, actor_id, workspace_id, target_type, target_id, origin,
       correlation_id, result, reason, after_redacted)
     VALUES ('finance', 'wallet.initial_balance_materialized', $1, $2,
             'finance_transaction', $3, $4, $5, 'success',
             'Saldo inicial informado no onboarding', $6::jsonb)`,
    [
      input.actorId,
      input.workspaceId,
      transactionRow.id,
      input.origin,
      input.correlationId,
      JSON.stringify({ kind: "adjustment", state: "posted", version: 0 }),
    ],
  );
  await client.query(
    `UPDATE workspace_preference
        SET initial_balance_materialized_at = now(),
            initial_balance_transaction_id = $2,
            updated_at = now()
      WHERE workspace_id = $1 AND initial_balance_materialized_at IS NULL`,
    [input.workspaceId, transactionRow.id],
  );
  return transactionRow.id;
}

async function ensureFinancialAccount(
  client: PgPoolClient,
  workspaceId: string,
  kind: string,
  name: string,
  currency: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO financial_account (workspace_id, kind, name, currency_code)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, kind, name) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [workspaceId, kind, name, currency],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("account insert failed");
  return id;
}

function civilToday(now: Date, timeZone: string): string {
  const parsedTimeZone = parseTimeZone(timeZone);
  if (!parsedTimeZone.ok) throw new FinanceConflictError("O fuso horário do espaço é inválido.");
  const date = todayInTimeZone(fixedClock(now), parsedTimeZone.value);
  if (!date.ok) throw new FinanceConflictError("O fuso horário do espaço é inválido.");
  return date.value;
}

async function assertCategoryNameAvailable(
  client: PgPoolClient,
  workspaceId: string,
  name: string,
  exceptId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM finance_category
      WHERE workspace_id = $1 AND id <> $2 AND archived = false AND lower(name) = lower($3)
      LIMIT 1`,
    [workspaceId, exceptId, name],
  );
  if (result.rows[0])
    throw new FinanceConflictError("Já existe uma categoria ativa com este nome.");
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function recurrenceDatesThrough(
  rule: Pick<
    RecurrenceRuleRow,
    "frequency" | "interval" | "start_on" | "end_on" | "max_occurrences" | "paused_on"
  >,
  today: string,
): readonly string[] {
  const parsedToday = parseLocalDate(today);
  const parsedStart = parseLocalDate(rule.start_on);
  if (!parsedToday.ok || !parsedStart.ok) {
    throw new FinanceConflictError("A recorrência possui uma data civil inválida.");
  }
  const horizon = addLocalDateMonths(parsedToday.value, 12);
  let through: string = horizon;
  if (rule.end_on && rule.end_on < through) through = rule.end_on;
  if (rule.paused_on) {
    const parsedPause = parseLocalDate(rule.paused_on);
    if (!parsedPause.ok) throw new FinanceConflictError("A pausa possui uma data civil inválida.");
    const beforePause = addLocalDateDays(parsedPause.value, -1);
    if (beforePause < through) through = beforePause;
  }
  const maxOccurrences = rule.max_occurrences ?? 10_000;
  return generateRecurrenceDatesUntil(
    rule.frequency,
    rule.start_on,
    through,
    rule.interval,
    maxOccurrences,
  );
}

function parseRecurrenceJobPayload(value: JsonValue): RecurrenceJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recurrence job payload is invalid");
  }
  const payload = value as Record<string, JsonValue>;
  if (typeof payload.workspaceId !== "string" || typeof payload.asOf !== "string") {
    throw new Error("recurrence job payload is invalid");
  }
  return { workspaceId: payload.workspaceId, asOf: payload.asOf };
}

function toRecurrenceView(row: RecurrenceRuleRow, currency: string): RecurrenceView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    amount: { currency, minor: row.amount_minor.toString() },
    frequency: row.frequency,
    interval: row.interval,
    startOn: row.start_on,
    endOn: row.end_on,
    maxOccurrences: row.max_occurrences,
    variable: row.variable,
    estimatedAmount: row.estimated_minor
      ? { currency, minor: row.estimated_minor.toString() }
      : null,
    description: row.description,
    pausedOn: row.paused_on,
    version: row.version,
  };
}

export function assertFinanceCapability(scope: FinanceScope, capability: "finance.write"): void {
  if (capability === "finance.write" && scope.role === "viewer") {
    throw new FinancePermissionError();
  }
}

export class FinanceNotFoundError extends Error {
  readonly code = "not_found" as const;
}
export class FinancePermissionError extends Error {
  readonly code = "permission_denied" as const;
  constructor() {
    super("O papel atual não pode alterar dados financeiros.");
  }
}
export class FinanceConflictError extends Error {
  readonly code = "conflict" as const;
}
export class VersionConflictError extends Error {
  readonly code = "version_conflict" as const;

  constructor(readonly currentVersion?: number) {
    super("O recurso foi alterado. Revise e tente novamente.");
  }
}

export function assertStatementCanReopen(input: { state: string; paidMinor: bigint }): void {
  if (input.paidMinor > 0n) {
    throw new FinanceConflictError(
      "Faturas com pagamentos não podem ser reabertas; cancele os pagamentos primeiro.",
    );
  }
  if (input.state !== "closed") {
    throw new FinanceConflictError("Somente uma fatura fechada pode ser reaberta.");
  }
}

function decodeStatementItemsCursor(cursor: string, secret: string): StatementItemsCursorPosition {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== statementItemsCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 3 ||
    position.some((value) => typeof value !== "string")
  ) {
    throw new InvalidCursorError();
  }
  const [occurredOn, createdAt, id] = position as [string, string, string];
  if (
    !parseLocalDate(occurredOn).ok ||
    Number.isNaN(Date.parse(createdAt)) ||
    !domainIdSchema.safeParse(id).success
  ) {
    throw new InvalidCursorError();
  }
  return [occurredOn, createdAt, id];
}

function decodeTransactionCursor(cursor: string, secret: string): TransactionCursorPosition {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== transactionCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 3 ||
    position.some((value) => typeof value !== "string")
  ) {
    throw new InvalidCursorError();
  }
  const [occurredOn, createdAt, id] = position as [string, string, string];
  if (
    !parseLocalDate(occurredOn).ok ||
    Number.isNaN(Date.parse(createdAt)) ||
    !domainIdSchema.safeParse(id).success
  ) {
    throw new InvalidCursorError();
  }
  return [occurredOn, createdAt, id];
}

function decodeFinanceAuditCursor(cursor: string, secret: string): FinanceAuditCursorPosition {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== financeAuditCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 2 ||
    position.some((value) => typeof value !== "string")
  ) {
    throw new InvalidCursorError();
  }
  const [occurredAt, id] = position as [string, string];
  if (Number.isNaN(Date.parse(occurredAt)) || !domainIdSchema.safeParse(id).success) {
    throw new InvalidCursorError();
  }
  return [occurredAt, id];
}

async function setFinanceScope(client: PgPoolClient, scope: FinanceScope, applicationRole: string) {
  // Read-only helpers do not use withUnitOfWork, so they must apply the same
  // least-privilege role before setting the transaction-local RLS context.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Invalid PostgreSQL role identifier");
  }
  await client.query(`SET LOCAL ROLE "${applicationRole}"`);
  await client.query(
    `SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.correlation_id', $3, true)`,
    [scope.workspaceId, scope.actorId, scope.correlationId],
  );
}

function toTransactionView(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    state: row.state,
    amount: { currency: row.currency_code, minor: row.amount_minor.toString() },
    settledAmount: { currency: row.currency_code, minor: row.settled_minor.toString() },
    occurredOn: row.occurred_on,
    dueOn: row.due_on,
    postedOn: row.posted_on ? new Date(row.posted_on).toISOString() : null,
    description: row.description,
    categoryId: row.category_id,
    cardId: row.card_id,
    statementId: row.statement_id,
    version: row.version,
  };
}

function toLoanView(row: LoanRow): LoanView {
  const principal = BigInt(row.principal_minor);
  const paid = BigInt(row.paid_minor);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    direction: row.direction,
    counterparty: row.counterparty,
    principal: { currency: row.currency_code, minor: principal.toString() },
    paid: { currency: row.currency_code, minor: paid.toString() },
    remaining: { currency: row.currency_code, minor: (principal - paid).toString() },
    occurredOn: row.occurred_on,
    dueOn: row.due_on,
    status: row.status,
    version: row.version,
  };
}

function loanAccountKind(direction: "lent" | "borrowed"): "loan_receivable" | "loan_payable" {
  return direction === "lent" ? "loan_receivable" : "loan_payable";
}

function loanAccountName(loanId: string): string {
  return `Empréstimo ${loanId}`;
}

function loanEventType(direction: "lent" | "borrowed", action: "principal" | "payment"): string {
  if (direction === "lent") {
    return action === "principal" ? "loan.principal.lent.v1" : "loan.payment.received.v1";
  }
  return action === "principal" ? "loan.principal.borrowed.v1" : "loan.payment.made.v1";
}

/**
 * Audit snapshots are deliberately smaller than a transaction view. Keep the
 * allowlist and value checks in one place so both writes and reads enforce the
 * same privacy boundary.
 */
export function redactFinanceAuditSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  if (typeof source.kind === "string") snapshot.kind = source.kind;
  if (typeof source.state === "string") snapshot.state = source.state;
  if (typeof source.direction === "string") snapshot.direction = source.direction;
  if (typeof source.status === "string") snapshot.status = source.status;
  if (typeof source.counterparty === "string") snapshot.counterparty = source.counterparty;
  for (const key of ["occurredOn", "dueOn"] as const) {
    if (source[key] === null || typeof source[key] === "string")
      snapshot[key] = source[key] ?? null;
  }
  for (const key of ["categoryId", "cardId", "statementId"] as const) {
    if (source[key] === null || typeof source[key] === "string")
      snapshot[key] = source[key] ?? null;
  }
  if (typeof source.version === "number" && Number.isInteger(source.version)) {
    snapshot.version = source.version;
  }
  return snapshot;
}

function toFinanceAuditEventView(row: FinanceAuditRow): FinanceAuditEventView {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    category: row.category,
    action: row.action,
    actorId: row.actor_id,
    occurredAt: normalizePostgresTimestamp(row.occurred_at),
    origin: row.origin,
    correlationId: row.correlation_id,
    result: row.result,
    reason: row.reason,
    before: redactFinanceAuditSnapshot(row.before_redacted),
    after: redactFinanceAuditSnapshot(row.after_redacted),
  };
}

/** PostgreSQL text preserves timestamptz fractional seconds; Date would truncate them. */
function normalizePostgresTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const normalized = value.trim().replace(" ", "T");
  return /[+-]\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
}

/** Snapshot allowlist deliberately excludes amount, description and identity secrets. */
function transactionAuditSnapshot(
  row: Pick<
    TransactionRow,
    "kind" | "state" | "category_id" | "card_id" | "statement_id" | "version"
  >,
): Record<string, unknown> {
  return {
    kind: row.kind,
    state: row.state,
    categoryId: row.category_id,
    cardId: row.card_id,
    statementId: row.statement_id,
    version: row.version,
  };
}

interface CreditCardRow {
  id: string;
  workspace_id: string;
  name: string;
  closing_day: number;
  due_day: number;
  holder: string | null;
  last_four: string | null;
  limit_minor: string | bigint | null;
  currency_code: string;
  archived: boolean;
  version: number;
}

async function lockCreditCard(
  client: PgPoolClient,
  workspaceId: string,
  cardId: string,
): Promise<CreditCardRow | null> {
  const result = await client.query<CreditCardRow>(
    `SELECT id, workspace_id, name, closing_day, due_day, holder, last_four,
            limit_minor, currency_code, archived, version
       FROM credit_card
      WHERE workspace_id = $1 AND id = $2
      FOR UPDATE`,
    [workspaceId, cardId],
  );
  return result.rows[0] ?? null;
}

function toCategoryView(row: {
  id: string;
  workspace_id: string;
  name: string;
  kind: "income" | "expense" | "both";
  archived: boolean;
  version: number;
}): CategoryView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    archived: row.archived,
    version: row.version,
  };
}

function toCreditCardView(row: CreditCardRow): CreditCardView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    closingDay: row.closing_day,
    dueDay: row.due_day,
    holder: row.holder,
    lastFour: row.last_four,
    limit:
      row.limit_minor === null
        ? null
        : { currency: row.currency_code, minor: row.limit_minor.toString() },
    archived: row.archived,
    version: row.version,
  };
}

function toStatementView(row: {
  id: string;
  workspace_id: string;
  card_id: string;
  period_start: string;
  closing_on: string;
  due_on: string;
  state: StatementView["state"];
  total_minor: string | bigint;
  paid_minor: string | bigint;
  currency_code: string;
  version: number;
}): StatementView {
  const total = BigInt(row.total_minor);
  const paid = BigInt(row.paid_minor);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cardId: row.card_id,
    periodStart: row.period_start,
    closingOn: row.closing_on,
    dueOn: row.due_on,
    state: row.state,
    total: { currency: row.currency_code, minor: total.toString() },
    paid: { currency: row.currency_code, minor: paid.toString() },
    openAmount: { currency: row.currency_code, minor: (total - paid).toString() },
    version: row.version,
  };
}
