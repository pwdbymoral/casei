import {
  createGoalSchema,
  domainIdSchema,
  goalAllocateSchema,
  goalReleaseSchema,
  goalSpendSchema,
  goalTransitionSchema,
  paginationQuerySchema,
  updateGoalSchema,
} from "@casei/contracts";
import type { Pool, PoolClient } from "@casei/database";
import { executeIdempotent, type JsonValue, withUnitOfWork } from "@casei/database";
import {
  assertBalancedLedgerEvent,
  calculateGoalCoverage,
  calculateGoalReservation,
  canonicalTransactionPostings,
  goalAllocation,
  goalStatusAfterReservation,
  Money,
  parseLocalDate,
} from "@casei/domain";
import {
  assertFinanceCapability,
  FinanceConflictError,
  FinanceNotFoundError,
  type FinanceScope,
  VersionConflictError,
} from "./finance-service.js";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./http/cursor.js";

export interface GoalServiceOptions {
  applicationRole?: string;
  cursorSecret?: string;
}

export interface GoalView {
  id: string;
  workspaceId: string;
  name: string;
  target: { currency: string; minor: string };
  reserved: { currency: string; minor: string };
  uncovered: { currency: string; minor: string };
  deadline: string | null;
  priority: "low" | "normal" | "high";
  status: "active" | "completed" | "paused" | "canceled";
  note: string | null;
  version: number;
}

export interface GoalMovementView {
  id: string;
  goalId: string;
  kind: "allocate" | "release" | "spend";
  amount: { currency: string; minor: string };
  transactionId: string | null;
  occurredOn: string;
  note: string | null;
}

export interface GoalMutationResult {
  goal: GoalView;
  replayed: boolean;
  transactionId?: string;
}

interface GoalRow {
  id: string;
  workspace_id: string;
  name: string;
  target_minor: string | bigint;
  currency_code: string;
  deadline: string | null;
  priority: GoalView["priority"];
  status: GoalView["status"];
  note: string | null;
  version: number;
  created_at: string | Date;
}

interface GoalTotals {
  allocated_minor: string | bigint;
  released_minor: string | bigint;
  spent_minor: string | bigint;
}

interface GoalMovementRow {
  id: string;
  goal_id: string;
  kind: GoalMovementView["kind"];
  amount_minor: string | bigint;
  currency_code: string;
  transaction_id: string | null;
  occurred_on: string;
  note: string | null;
  created_at: string | Date;
}

export class GoalService {
  private readonly applicationRole: string;
  private readonly cursorSecret: string;

  constructor(
    private readonly pool: Pool,
    options: GoalServiceOptions = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
    const cursorSecret = options.cursorSecret ?? process.env.CASEI_CURSOR_SECRET;
    if (process.env.NODE_ENV === "production" && !cursorSecret) {
      throw new Error("CASEI_CURSOR_SECRET is required in production");
    }
    this.cursorSecret = cursorSecret ?? "development-only-cursor-secret";
  }

  async createGoal(
    scope: FinanceScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ goal: GoalView; replayed: boolean }> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = createGoalSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/goals`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const currency = await this.workspaceCurrency(client, scope.workspaceId);
          assertCurrency(parsed.target.currency, currency);
          const goalResult = await client.query<{ id: string }>(
            `INSERT INTO goal (workspace_id, name, target_minor, currency_code, deadline, priority, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              scope.workspaceId,
              parsed.name,
              BigInt(parsed.target.minor),
              currency,
              parsed.deadline ?? null,
              parsed.priority,
              parsed.note ?? null,
            ],
          );
          const id = goalResult.rows[0]?.id;
          if (!id) throw new Error("goal insert failed");
          const goal = await this.getGoalInTransaction(client, scope.workspaceId, id);
          if (!goal) throw new FinanceNotFoundError();
          await this.recordGoalAudit(client, scope, id, "goal.created", null, goal);
          return { statusCode: 201, response: goal as unknown as JsonValue };
        },
      }),
    );
    return { goal: result.response as unknown as GoalView, replayed: result.replayed };
  }

  async listGoals(
    scope: FinanceScope,
    input: unknown = {},
  ): Promise<{ items: GoalView[]; nextCursor: string | null; hasMore: boolean }> {
    const parsed = paginationQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      const values: unknown[] = [scope.workspaceId];
      const conditions = ["g.workspace_id = $1"];
      const cursor = parsed.cursor ? decodeGoalCursor(parsed.cursor, this.cursorSecret) : null;
      if (cursor) {
        values.push(cursor[0], cursor[1]);
        conditions.push(
          `(g.created_at < $${values.length - 1}::timestamptz OR (g.created_at = $${values.length - 1}::timestamptz AND g.id < $${values.length}::uuid))`,
        );
      }
      values.push(parsed.limit + 1);
      const result = await client.query<GoalRow & GoalTotals>(
        `SELECT g.id, g.workspace_id, g.name, g.target_minor, g.currency_code, g.deadline,
                g.priority, g.status, g.note, g.version, g.created_at,
                COALESCE(SUM(CASE WHEN m.kind = 'allocate' THEN m.amount_minor ELSE 0 END), 0) AS allocated_minor,
                COALESCE(SUM(CASE WHEN m.kind = 'release' THEN m.amount_minor ELSE 0 END), 0) AS released_minor,
                COALESCE(SUM(CASE WHEN m.kind = 'spend' THEN m.amount_minor ELSE 0 END), 0) AS spent_minor
           FROM goal g LEFT JOIN goal_reservation_movement m ON m.workspace_id = g.workspace_id AND m.goal_id = g.id
          WHERE ${conditions.join(" AND ")}
          GROUP BY g.id
          ORDER BY g.created_at DESC, g.id DESC
          LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > parsed.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.limit) : result.rows;
      const walletBalance = await this.walletBalance(client, scope.workspaceId);
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last?.created_at
          ? encodeCursor(
              {
                ordering: goalCursorOrdering,
                position: [new Date(last.created_at).toISOString(), last.id],
              },
              this.cursorSecret,
            )
          : null;
      return {
        items: rows.map((row) => toGoalView(row, row, walletBalance)),
        nextCursor,
        hasMore,
      };
    });
  }

  async getGoal(scope: FinanceScope, goalId: string): Promise<GoalView | null> {
    return this.withScopedClient(scope, async (client) =>
      this.getGoalInTransaction(client, scope.workspaceId, goalId),
    );
  }

  async listMovements(
    scope: FinanceScope,
    goalId: string,
    input: unknown = {},
  ): Promise<{ items: GoalMovementView[]; nextCursor: string | null; hasMore: boolean }> {
    const parsed = paginationQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      await this.requireGoal(client, scope.workspaceId, goalId);
      const values: unknown[] = [scope.workspaceId, goalId];
      const conditions = ["workspace_id = $1", "goal_id = $2"];
      const cursor = parsed.cursor
        ? decodeGoalMovementCursor(parsed.cursor, this.cursorSecret)
        : null;
      if (cursor) {
        values.push(cursor[0], cursor[1], cursor[2]);
        conditions.push(
          `(occurred_on < $${values.length - 2}::date OR (occurred_on = $${values.length - 2}::date AND created_at < $${values.length - 1}::timestamptz) OR (occurred_on = $${values.length - 2}::date AND created_at = $${values.length - 1}::timestamptz AND id < $${values.length}::uuid))`,
        );
      }
      values.push(parsed.limit + 1);
      const result = await client.query<GoalMovementRow>(
        `SELECT id, goal_id, kind, amount_minor, currency_code, transaction_id, occurred_on, note, created_at
           FROM goal_reservation_movement
          WHERE ${conditions.join(" AND ")}
          ORDER BY occurred_on DESC, created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > parsed.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.limit) : result.rows;
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last?.created_at
          ? encodeCursor(
              {
                ordering: goalMovementCursorOrdering,
                position: [last.occurred_on, new Date(last.created_at).toISOString(), last.id],
              },
              this.cursorSecret,
            )
          : null;
      return { items: rows.map(toMovementView), nextCursor, hasMore };
    });
  }

  async updateGoal(
    scope: FinanceScope,
    goalId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoalMutationResult> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = updateGoalSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:PATCH:/goals/${goalId}`,
        key: idempotencyKey,
        request: { input: parsed, expectedVersion },
        execute: async () => {
          const workspaceCurrency = await this.workspaceCurrency(client, scope.workspaceId);
          const current = await this.lockGoal(client, scope.workspaceId, goalId);
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (current.status === "canceled")
            throw new FinanceConflictError("Uma meta cancelada não pode ser editada.");
          assertCurrency(current.currency_code, workspaceCurrency);
          if (parsed.target) assertCurrency(parsed.target.currency, current.currency_code);
          const fields: string[] = [];
          const values: unknown[] = [scope.workspaceId, goalId];
          const add = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
          };
          if (parsed.name !== undefined) fields.push(`name = ${add(parsed.name)}`);
          if (parsed.target !== undefined)
            fields.push(`target_minor = ${add(BigInt(parsed.target.minor))}`);
          if (parsed.deadline !== undefined) fields.push(`deadline = ${add(parsed.deadline)}`);
          if (parsed.priority !== undefined) fields.push(`priority = ${add(parsed.priority)}`);
          if (parsed.note !== undefined) fields.push(`note = ${add(parsed.note)}`);
          const totals = await this.goalTotals(client, scope.workspaceId, goalId);
          const reserved = reservedFromTotals(totals);
          const targetMinor = parsed.target
            ? BigInt(parsed.target.minor)
            : BigInt(current.target_minor);
          fields.push(
            `status = ${add(goalStatusAfterReservation({ status: current.status, targetMinor, reservedMinor: reserved }))}`,
          );
          fields.push("version = version + 1", "updated_at = now()");
          values.push(expectedVersion);
          const updated = await client.query<GoalRow>(
            `UPDATE goal SET ${fields.join(", ")} WHERE workspace_id = $1 AND id = $2 AND version = $${values.length}
             RETURNING id, workspace_id, name, target_minor, currency_code, deadline, priority, status, note, version`,
            values,
          );
          if (!updated.rows[0]) throw new VersionConflictError(current.version);
          const goal = await this.getGoalInTransaction(client, scope.workspaceId, goalId);
          if (!goal) throw new FinanceNotFoundError();
          await this.recordGoalAudit(client, scope, goalId, "goal.updated", current, goal);
          return { statusCode: 200, response: { goal, replayed: false } as unknown as JsonValue };
        },
      }),
    );
    return {
      ...(result.response as unknown as Omit<GoalMutationResult, "replayed">),
      replayed: result.replayed,
    };
  }

  async allocateGoal(
    scope: FinanceScope,
    goalId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoalMutationResult> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = goalAllocateSchema.parse(input);
    return this.reserve(
      scope,
      goalId,
      parsed.amount,
      parsed.occurredOn,
      parsed.note ?? null,
      "allocate",
      idempotencyKey,
      expectedVersion,
      parsed.allowUncovered,
    );
  }

  async releaseGoal(
    scope: FinanceScope,
    goalId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoalMutationResult> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = goalReleaseSchema.parse(input);
    return this.reserve(
      scope,
      goalId,
      parsed.amount,
      parsed.occurredOn,
      parsed.note ?? null,
      "release",
      idempotencyKey,
      expectedVersion,
      true,
    );
  }

  async spendGoal(
    scope: FinanceScope,
    goalId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoalMutationResult> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = goalSpendSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/goals/${goalId}/spend`,
        key: idempotencyKey,
        request: { input: parsed, expectedVersion },
        execute: async () => {
          const workspaceCurrency = await this.workspaceCurrency(client, scope.workspaceId);
          const current = await this.lockGoal(client, scope.workspaceId, goalId);
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (current.status === "paused" || current.status === "canceled")
            throw new FinanceConflictError("Esta meta não aceita gastos no estado atual.");
          assertCurrency(current.currency_code, workspaceCurrency);
          assertCurrency(parsed.amount.currency, current.currency_code);
          const totals = await this.goalTotals(client, scope.workspaceId, goalId);
          const reserved = reservedFromTotals(totals);
          const amount = BigInt(parsed.amount.minor);
          if (amount > reserved)
            throw new FinanceConflictError("O gasto excede a reserva disponível da meta.");
          if (parsed.categoryId)
            await this.assertExpenseCategory(client, scope.workspaceId, parsed.categoryId);
          const occurredOn =
            parsed.occurredOn ?? (await this.workspaceToday(client, scope.workspaceId));
          const transactionId = await this.insertExpense(
            client,
            scope.workspaceId,
            amount,
            current.currency_code,
            occurredOn,
            parsed.description,
            parsed.categoryId ?? null,
            goalId,
          );
          const accounts = await this.ensureExpenseAccounts(
            client,
            scope.workspaceId,
            current.currency_code,
          );
          const postings = canonicalTransactionPostings({
            kind: "expense",
            instrument: "wallet",
            amount: Money.fromTrusted(amount, current.currency_code as never),
            accounts,
          });
          await this.publishEvent(
            client,
            scope,
            transactionId,
            "goal.spend.v1",
            current.currency_code,
            postings,
            occurredOn,
          );
          await client.query(
            `INSERT INTO goal_reservation_movement (workspace_id, goal_id, kind, amount_minor, currency_code, transaction_id, occurred_on, note)
             VALUES ($1, $2, 'spend', $3, $4, $5, $6, $7)`,
            [
              scope.workspaceId,
              goalId,
              amount,
              current.currency_code,
              transactionId,
              occurredOn,
              parsed.description,
            ],
          );
          const nextReserved = reserved - amount;
          const nextStatus = goalStatusAfterReservation({
            status: current.status,
            targetMinor: BigInt(current.target_minor),
            reservedMinor: nextReserved,
          });
          const updated = await client.query(
            `UPDATE goal SET status = $1, version = version + 1, updated_at = now()
              WHERE workspace_id = $2 AND id = $3 AND version = $4`,
            [nextStatus, scope.workspaceId, goalId, expectedVersion],
          );
          if (!updated.rowCount) throw new VersionConflictError(current.version);
          const goal = await this.getGoalInTransaction(client, scope.workspaceId, goalId);
          if (!goal) throw new FinanceNotFoundError();
          await this.recordGoalAudit(client, scope, goalId, "goal.spent", current, goal);
          return {
            statusCode: 201,
            response: { goal, transactionId, replayed: false } as unknown as JsonValue,
          };
        },
      }),
    );
    return {
      ...(result.response as unknown as Omit<GoalMutationResult, "replayed">),
      replayed: result.replayed,
    };
  }

  async transitionGoal(
    scope: FinanceScope,
    goalId: string,
    action: "pause" | "resume" | "cancel" | "complete",
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoalMutationResult> {
    assertFinanceCapability(scope, "finance.write");
    const parsed = goalTransitionSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/goals/${goalId}/${action}`,
        key: idempotencyKey,
        request: { ...parsed, expectedVersion },
        execute: async () => {
          const current = await this.lockGoal(client, scope.workspaceId, goalId);
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          const allowed =
            action === "pause"
              ? current.status === "active"
              : action === "resume"
                ? current.status === "paused"
                : action === "complete"
                  ? current.status === "active" || current.status === "paused"
                  : current.status !== "canceled";
          if (!allowed)
            throw new FinanceConflictError("A transição da meta não é válida no estado atual.");
          const status =
            action === "pause"
              ? "paused"
              : action === "resume"
                ? "active"
                : action === "complete"
                  ? "completed"
                  : "canceled";
          const updated = await client.query(
            `UPDATE goal SET status = $1, version = version + 1, updated_at = now()
              WHERE workspace_id = $2 AND id = $3 AND version = $4`,
            [status, scope.workspaceId, goalId, expectedVersion],
          );
          if (!updated.rowCount) throw new VersionConflictError(current.version);
          const goal = await this.getGoalInTransaction(client, scope.workspaceId, goalId);
          if (!goal) throw new FinanceNotFoundError();
          await this.recordGoalAudit(client, scope, goalId, `goal.${action}`, current, goal);
          return { statusCode: 200, response: { goal, replayed: false } as unknown as JsonValue };
        },
      }),
    );
    return {
      ...(result.response as unknown as Omit<GoalMutationResult, "replayed">),
      replayed: result.replayed,
    };
  }

  private async reserve(
    scope: FinanceScope,
    goalId: string,
    amountInput: { currency: string; minor: string },
    occurredOnInput: string | undefined,
    note: string | null,
    kind: "allocate" | "release",
    idempotencyKey: string,
    expectedVersion: number,
    allowUncovered: boolean,
  ): Promise<GoalMutationResult> {
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/goals/${goalId}/${kind}`,
        key: idempotencyKey,
        request: { amountInput, occurredOnInput, note, allowUncovered, expectedVersion },
        execute: async () => {
          const workspaceCurrency = await this.workspaceCurrency(client, scope.workspaceId);
          const current = await this.lockGoal(client, scope.workspaceId, goalId);
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (
            current.status === "paused" ||
            current.status === "canceled" ||
            (kind === "allocate" && current.status === "completed")
          )
            throw new FinanceConflictError("A meta não aceita esta reserva no estado atual.");
          assertCurrency(current.currency_code, workspaceCurrency);
          assertCurrency(amountInput.currency, current.currency_code);
          const totals = await this.goalTotals(client, scope.workspaceId, goalId);
          const reserved = reservedFromTotals(totals);
          const amount = BigInt(amountInput.minor);
          const occurredOn =
            occurredOnInput ?? (await this.workspaceToday(client, scope.workspaceId));
          if (kind === "allocate") {
            const workspaceReserved = await this.workspaceReserved(client, scope.workspaceId);
            const walletBalance = await this.walletBalance(client, scope.workspaceId);
            goalAllocation({
              reservedMinor: workspaceReserved,
              walletBalanceMinor: walletBalance,
              amountMinor: amount,
              allowUncovered,
            });
          } else if (amount > reserved) {
            throw new FinanceConflictError("A retirada excede o valor reservado da meta.");
          }
          await client.query(
            `INSERT INTO goal_reservation_movement (workspace_id, goal_id, kind, amount_minor, currency_code, occurred_on, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [scope.workspaceId, goalId, kind, amount, current.currency_code, occurredOn, note],
          );
          const nextReserved = kind === "allocate" ? reserved + amount : reserved - amount;
          const nextStatus = goalStatusAfterReservation({
            status: current.status,
            targetMinor: BigInt(current.target_minor),
            reservedMinor: nextReserved,
          });
          const updated = await client.query(
            `UPDATE goal SET status = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND id = $3 AND version = $4`,
            [nextStatus, scope.workspaceId, goalId, expectedVersion],
          );
          if (!updated.rowCount) throw new VersionConflictError(current.version);
          const goal = await this.getGoalInTransaction(client, scope.workspaceId, goalId);
          if (!goal) throw new FinanceNotFoundError();
          await this.recordGoalAudit(client, scope, goalId, `goal.${kind}`, current, goal);
          return { statusCode: 200, response: { goal, replayed: false } as unknown as JsonValue };
        },
      }),
    );
    return {
      ...(result.response as unknown as Omit<GoalMutationResult, "replayed">),
      replayed: result.replayed,
    };
  }

  private async getGoalInTransaction(
    client: PoolClient,
    workspaceId: string,
    goalId: string,
  ): Promise<GoalView | null> {
    const result = await client.query<GoalRow>(
      `SELECT id, workspace_id, name, target_minor, currency_code, deadline, priority, status, note, version
         FROM goal WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, goalId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const totals = await this.goalTotals(client, workspaceId, goalId);
    const walletBalance = await this.walletBalance(client, workspaceId);
    return toGoalView(row, totals, walletBalance);
  }

  private async requireGoal(
    client: PoolClient,
    workspaceId: string,
    goalId: string,
  ): Promise<GoalRow> {
    const result = await client.query<GoalRow>(
      `SELECT id, workspace_id, name, target_minor, currency_code, deadline, priority, status, note, version FROM goal WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, goalId],
    );
    const row = result.rows[0];
    if (!row) throw new FinanceNotFoundError();
    return row;
  }

  private async lockGoal(
    client: PoolClient,
    workspaceId: string,
    goalId: string,
  ): Promise<GoalRow> {
    const result = await client.query<GoalRow>(
      `SELECT id, workspace_id, name, target_minor, currency_code, deadline, priority, status, note, version FROM goal WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, goalId],
    );
    const row = result.rows[0];
    if (!row) throw new FinanceNotFoundError();
    return row;
  }

  private async goalTotals(
    client: PoolClient,
    workspaceId: string,
    goalId: string,
  ): Promise<GoalTotals> {
    const result = await client.query<GoalTotals>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'allocate' THEN amount_minor ELSE 0 END), 0) AS allocated_minor,
              COALESCE(SUM(CASE WHEN kind = 'release' THEN amount_minor ELSE 0 END), 0) AS released_minor,
              COALESCE(SUM(CASE WHEN kind = 'spend' THEN amount_minor ELSE 0 END), 0) AS spent_minor
         FROM goal_reservation_movement WHERE workspace_id = $1 AND goal_id = $2`,
      [workspaceId, goalId],
    );
    return result.rows[0] ?? { allocated_minor: 0n, released_minor: 0n, spent_minor: 0n };
  }

  private async walletBalance(client: PoolClient, workspaceId: string): Promise<bigint> {
    const result = await client.query<{ balance_minor: string | bigint | null }>(
      `SELECT COALESCE(SUM(le.amount_minor), 0) AS balance_minor
         FROM ledger_entry le JOIN financial_account fa ON fa.id = le.account_id
        WHERE le.workspace_id = $1 AND fa.workspace_id = $1 AND fa.kind = 'wallet'`,
      [workspaceId],
    );
    return BigInt(result.rows[0]?.balance_minor ?? 0);
  }

  private async workspaceReserved(client: PoolClient, workspaceId: string): Promise<bigint> {
    const result = await client.query<{ reserved_minor: string | bigint | null }>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'allocate' THEN amount_minor
                               WHEN kind IN ('release', 'spend') THEN -amount_minor
                               ELSE 0 END), 0) AS reserved_minor
         FROM goal_reservation_movement
        WHERE workspace_id = $1`,
      [workspaceId],
    );
    const reserved = BigInt(result.rows[0]?.reserved_minor ?? 0);
    if (reserved < 0n)
      throw new FinanceConflictError("As reservas do espaço estão inconsistentes.");
    return reserved;
  }

  private async workspaceCurrency(client: PoolClient, workspaceId: string): Promise<string> {
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

  private async workspaceToday(client: PoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ timezone: string }>(
      `SELECT timezone FROM workspace_preference WHERE workspace_id = $1`,
      [workspaceId],
    );
    const timezone = result.rows[0]?.timezone ?? "UTC";
    try {
      const values = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date())
          .map((part) => [part.type, part.value]),
      );
      const date = `${values.year}-${values.month}-${values.day}`;
      if (!parseLocalDate(date).ok) throw new Error("invalid date");
      return date;
    } catch {
      throw new FinanceConflictError("O fuso horário do espaço é inválido.");
    }
  }

  private async insertExpense(
    client: PoolClient,
    workspaceId: string,
    amount: bigint,
    currency: string,
    occurredOn: string,
    description: string,
    categoryId: string | null,
    goalId: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance_transaction (workspace_id, kind, state, instrument, amount_minor, settled_minor, currency_code, occurred_on, posted_on, cash_settled_on, description, category_id, goal_id)
       VALUES ($1, 'expense', 'posted', 'wallet', $2, $2, $3, $4, now(), now(), $5, $6, $7) RETURNING id`,
      [workspaceId, amount, currency, occurredOn, description, categoryId, goalId],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("goal expense insert failed");
    return id;
  }

  private async assertExpenseCategory(
    client: PoolClient,
    workspaceId: string,
    categoryId: string,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM finance_category WHERE workspace_id = $1 AND id = $2 AND archived = false AND kind IN ('expense', 'both')`,
      [workspaceId, categoryId],
    );
    if (!result.rows[0])
      throw new FinanceConflictError("A categoria não está disponível para despesas.");
  }

  private async ensureExpenseAccounts(client: PoolClient, workspaceId: string, currency: string) {
    const wallet = await this.ensureAccount(client, workspaceId, "wallet", "Carteira", currency);
    const expense = await this.ensureAccount(client, workspaceId, "expense", "Despesas", currency);
    return { wallet, income: "unused-income", expense, adjustment: "unused-adjustment" };
  }

  private async ensureAccount(
    client: PoolClient,
    workspaceId: string,
    kind: string,
    name: string,
    currency: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_account (workspace_id, kind, name, currency_code) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, kind, name) DO UPDATE SET updated_at = now() RETURNING id`,
      [workspaceId, kind, name, currency],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("account insert failed");
    return id;
  }

  private async publishEvent(
    client: PoolClient,
    scope: FinanceScope,
    transactionId: string,
    eventType: string,
    currency: string,
    postings: readonly { accountId: string; amount: Money }[],
    occurredOn: string,
  ): Promise<void> {
    assertBalancedLedgerEvent(postings);
    const event = await client.query<{ id: string }>(
      `INSERT INTO ledger_event (workspace_id, transaction_id, event_type, currency_code, status, occurred_on, published_at) VALUES ($1, $2, $3, $4, 'published', $5, now()) RETURNING id`,
      [scope.workspaceId, transactionId, eventType, currency, occurredOn],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("ledger event insert failed");
    for (const posting of postings) {
      await client.query(
        `INSERT INTO ledger_entry (workspace_id, event_id, account_id, currency_code, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
        [scope.workspaceId, eventId, posting.accountId, currency, posting.amount.minor],
      );
    }
  }

  private async recordGoalAudit(
    client: PoolClient,
    scope: FinanceScope,
    goalId: string,
    action: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    const redactedBefore = redactGoalSnapshot(before);
    const redactedAfter = redactGoalSnapshot(after);
    await client.query(
      `INSERT INTO audit_event (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result, before_redacted, after_redacted)
       VALUES ('finance', $1, $2, $3, 'goal', $4, 'api', $5, 'success', $6::jsonb, $7::jsonb)`,
      [
        action,
        scope.actorId,
        scope.workspaceId,
        goalId,
        scope.correlationId,
        redactedBefore ? JSON.stringify(redactedBefore) : null,
        redactedAfter ? JSON.stringify(redactedAfter) : null,
      ],
    );
  }

  private async withScopedClient<T>(
    scope: FinanceScope,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setGoalScope(client, scope, this.applicationRole);
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
    callback: (context: { client: PoolClient }) => Promise<T>,
  ): Promise<T> {
    return withUnitOfWork(this.pool, { ...scope, applicationRole: this.applicationRole }, callback);
  }
}

function assertCurrency(actual: string, expected: string): void {
  if (actual !== expected) throw new FinanceConflictError("A moeda deve ser a mesma do espaço.");
}

const goalCursorOrdering = "created_at,id";
const goalMovementCursorOrdering = "occurred_on,created_at,id";

function decodeGoalCursor(cursor: string, secret: string): [string, string] {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== goalCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 2 ||
    position.some((value) => typeof value !== "string")
  ) {
    throw new InvalidCursorError();
  }
  const [createdAt, id] = position as [string, string];
  if (Number.isNaN(Date.parse(createdAt)) || !domainIdSchema.safeParse(id).success) {
    throw new InvalidCursorError();
  }
  return [createdAt, id];
}

function decodeGoalMovementCursor(cursor: string, secret: string): [string, string, string] {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== goalMovementCursorOrdering ||
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

function reservedFromTotals(totals: GoalTotals): bigint {
  return calculateGoalReservation({
    allocatedMinor: BigInt(totals.allocated_minor),
    releasedMinor: BigInt(totals.released_minor),
    spentMinor: BigInt(totals.spent_minor),
  });
}

function toGoalView(row: GoalRow, totals: GoalTotals, walletBalanceMinor: bigint): GoalView {
  const reservedMinor = reservedFromTotals(totals);
  const uncoveredMinor = calculateGoalCoverage(reservedMinor, walletBalanceMinor).uncoveredMinor;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    target: { currency: row.currency_code, minor: BigInt(row.target_minor).toString() },
    reserved: { currency: row.currency_code, minor: reservedMinor.toString() },
    uncovered: { currency: row.currency_code, minor: uncoveredMinor.toString() },
    deadline: row.deadline,
    priority: row.priority,
    status: row.status,
    note: row.note,
    version: row.version,
  };
}

function toMovementView(row: GoalMovementRow): GoalMovementView {
  return {
    id: row.id,
    goalId: row.goal_id,
    kind: row.kind,
    amount: { currency: row.currency_code, minor: BigInt(row.amount_minor).toString() },
    transactionId: row.transaction_id,
    occurredOn: row.occurred_on,
    note: row.note,
  };
}

function redactGoalSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of ["status", "priority", "version"] as const) {
    if (typeof source[key] === "string" || typeof source[key] === "number")
      snapshot[key] = source[key];
  }
  return snapshot;
}

async function setGoalScope(
  client: PoolClient,
  scope: FinanceScope,
  applicationRole: string,
): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(applicationRole))
    throw new Error("Invalid PostgreSQL role identifier");
  await client.query(`SET LOCAL ROLE "${applicationRole}"`);
  await client.query(
    `SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.correlation_id', $3, true)`,
    [scope.workspaceId, scope.actorId, scope.correlationId],
  );
}
