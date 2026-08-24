import {
  type CreateTransactionInput,
  createCategorySchema,
  createCreditCardSchema,
  createInstallmentPlanSchema,
  createRecurrenceSchema,
  createTransactionSchema,
  domainIdSchema,
  type TransactionListQuery,
} from "@casei/contracts";
import type { PoolClient as PgPoolClient, Pool } from "@casei/database";
import { executeIdempotent, type JsonValue, withUnitOfWork } from "@casei/database";
import {
  assertBalancedLedgerEvent,
  calculateStatementDates,
  canonicalCardPaymentPostings,
  canonicalTransactionPostings,
  distributeInstallments,
  generateRecurrenceDates,
  Money,
  parseLocalDate,
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
  created_at?: Date | string;
  version: number;
}

interface FinanceAuditRow {
  id: string;
  transaction_id: string;
  category: string;
  action: string;
  actor_id: string | null;
  occurred_at: Date | string;
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
        `SELECT id, target_id AS transaction_id, category, action, actor_id, occurred_at,
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
                  position: [new Date(last.occurred_at).toISOString(), last.id],
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
        `SELECT id, target_id AS transaction_id, category, action, actor_id, occurred_at,
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
  ): Promise<TransactionView> {
    assertFinanceCapability(scope, "finance.write");
    return this.mutateTransaction(
      scope,
      id,
      idempotencyKey,
      expectedVersion,
      "transactions/:id/post",
      async (client, row) => {
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
          if (recurrence.rows[0]?.variable) {
            throw new FinanceConflictError(
              "Uma ocorrência variável exige confirmar o valor efetivo antes da liquidação.",
            );
          }
        }
        await this.publishTransaction(
          client,
          scope,
          row,
          BigInt(row.amount_minor) - BigInt(row.settled_minor),
        );
        const result = await client.query<TransactionRow>(
          `UPDATE finance_transaction
            SET state = 'posted', settled_minor = amount_minor, posted_on = coalesce(posted_on, now()), cash_settled_on = CASE WHEN instrument = 'wallet' THEN now() ELSE cash_settled_on END, version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND version = $3
          RETURNING id, workspace_id, kind, state, amount_minor, settled_minor, currency_code, occurred_on, due_on, posted_on, description, category_id, card_id, statement_id, recurrence_id, version`,
          [scope.workspaceId, id, row.version],
        );
        if (!result.rows[0]) throw new VersionConflictError();
        await this.recordTransactionAudit(
          client,
          scope,
          id,
          "transaction.posted",
          { state: row.state, version: row.version },
          { state: result.rows[0].state, version: result.rows[0].version },
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
      async (client, row) => {
        if (row.state !== "posted" && row.state !== "partially_settled") {
          throw new FinanceConflictError("A transação não está realizada.");
        }
        const original = await client.query<{ id: string }>(
          `SELECT id FROM ledger_event WHERE workspace_id = $1 AND transaction_id = $2 AND event_type IN ('transaction.posted.v1', 'statement.payment.v1') ORDER BY created_at ASC LIMIT 1`,
          [scope.workspaceId, id],
        );
        const eventId = original.rows[0]?.id;
        if (!eventId) throw new FinanceConflictError("O lançamento original não foi encontrado.");
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
          const nextTotal = BigInt(statementRow.total_minor) - BigInt(row.amount_minor);
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
        const entries = await client.query<{
          account_id: string;
          currency_code: string;
          amount_minor: string;
        }>(
          `SELECT account_id, currency_code, amount_minor FROM ledger_entry WHERE workspace_id = $1 AND event_id = $2`,
          [scope.workspaceId, eventId],
        );
        const reversal = await client.query<{ id: string }>(
          `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at, reversed_event_id)
         VALUES ($1, $2, 'transaction.reversed.v1', $3, 'published', $4, now(), $5) RETURNING id`,
          [scope.workspaceId, id, row.currency_code, row.occurred_on, eventId],
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
          { state: row.state, version: row.version },
          { state: result.rows[0].state, version: result.rows[0].version },
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
          const result = await client.query(
            `INSERT INTO finance_category (workspace_id, name, kind) VALUES ($1, $2, $3) RETURNING id, workspace_id, name, kind, archived, version`,
            [scope.workspaceId, parsed.name, parsed.kind],
          );
          const row = result.rows[0];
          if (!row) throw new Error("category insert failed");
          return { statusCode: 201, response: toCategoryView(row) as unknown as JsonValue };
        },
      }),
    );
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

  async createRecurrence(scope: FinanceScope, input: unknown, idempotencyKey: string) {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createRecurrenceSchema.parse(input);
    return this.withUnitOfWork(scope, async ({ client }) =>
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
          const count = parsed.maxOccurrences ?? 12;
          const dates = generateRecurrenceDates(
            parsed.frequency,
            parsed.startOn,
            count,
            parsed.interval,
          ).filter((date) => !parsed.endOn || date <= parsed.endOn);
          const rule = await client.query<{ id: string }>(
            `INSERT INTO recurrence_rule (workspace_id, frequency, interval, start_on, end_on, max_occurrences, variable, estimated_minor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              scope.workspaceId,
              parsed.frequency,
              parsed.interval,
              parsed.startOn,
              parsed.endOn ?? null,
              parsed.maxOccurrences ?? null,
              parsed.variable,
              parsed.estimatedAmount ? BigInt(parsed.estimatedAmount.minor) : null,
            ],
          );
          const recurrenceId = rule.rows[0]?.id;
          if (!recurrenceId) throw new Error("recurrence rule insert failed");
          for (const date of dates) {
            const transaction = await client.query<{ id: string }>(
              `INSERT INTO finance_transaction (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, due_on, description, recurrence_id) VALUES ($1, $2, 'planned', 'wallet', $3, 0, $4, $5, $5, $6, $7) RETURNING id`,
              [
                scope.workspaceId,
                parsed.kind,
                BigInt(parsed.amount.minor),
                parsed.amount.currency,
                date,
                parsed.description,
                recurrenceId,
              ],
            );
            const transactionId = transaction.rows[0]?.id;
            if (!transactionId) throw new Error("recurrence transaction insert failed");
            await this.recordTransactionAudit(
              client,
              scope,
              transactionId,
              "transaction.created",
              null,
              {
                kind: parsed.kind,
                state: "planned",
                categoryId: null,
                cardId: null,
                statementId: null,
                version: 0,
              },
            );
            await client.query(
              `INSERT INTO recurrence_occurrence (workspace_id, recurrence_id, transaction_id, occurrence_on) VALUES ($1, $2, $3, $4) ON CONFLICT (recurrence_id, occurrence_on) DO NOTHING`,
              [scope.workspaceId, recurrenceId, transactionId, date],
            );
          }
          return {
            statusCode: 201,
            response: {
              id: recurrenceId,
              frequency: parsed.frequency,
              occurrences: dates,
            } as JsonValue,
          };
        },
      }),
    );
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
        "transaction.posted.v1",
        row.currency_code,
        postings.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
        row.occurred_on,
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
      "transaction.posted.v1",
      row.currency_code,
      entries.map((entry) => ({ accountId: entry.accountId, amount: entry.amount.minor })),
      row.occurred_on,
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
    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_account (workspace_id, kind, name, currency_code) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, kind, name) DO UPDATE SET updated_at = now() RETURNING id`,
      [workspaceId, kind, name, currency],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("account insert failed");
    return id;
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
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
         (category, action, actor_id, workspace_id, target_type, target_id,
          origin, correlation_id, result, before_redacted, after_redacted)
       VALUES ('finance', $1, $2, $3, 'finance_transaction', $4, 'api', $5, 'success', $6::jsonb, $7::jsonb)`,
      [
        action,
        scope.actorId,
        scope.workspaceId,
        transactionId,
        scope.correlationId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ],
    );
  }

  private async workspaceCurrency(client: PgPoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM workspace_preference WHERE workspace_id = $1`,
      [workspaceId],
    );
    return result.rows[0]?.currency_code ?? "BRL";
  }

  private async workspaceToday(client: PgPoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ timezone: string }>(
      `SELECT timezone FROM workspace_preference WHERE workspace_id = $1`,
      [workspaceId],
    );
    const timezone = result.rows[0]?.timezone ?? "UTC";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const date = `${values.year}-${values.month}-${values.day}`;
      if (!parseLocalDate(date).ok) throw new Error("invalid local date");
      return date;
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
    callback: (client: PgPoolClient, row: TransactionRow) => Promise<TransactionView>,
  ): Promise<TransactionView> {
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/${command}/${id}`,
        key,
        request: { id, expectedVersion },
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

function assertFinanceCapability(scope: FinanceScope, capability: "finance.write"): void {
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

function asAuditSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toFinanceAuditEventView(row: FinanceAuditRow): FinanceAuditEventView {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    category: row.category,
    action: row.action,
    actorId: row.actor_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    origin: row.origin,
    correlationId: row.correlation_id,
    result: row.result,
    reason: row.reason,
    before: asAuditSnapshot(row.before_redacted),
    after: asAuditSnapshot(row.after_redacted),
  };
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

function toCreditCardView(row: {
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
}): CreditCardView {
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
