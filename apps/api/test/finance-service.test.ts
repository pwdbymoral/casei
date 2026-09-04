import { describe, expect, it, vi } from "vitest";

import {
  assertStatementCanReopen,
  assertVariableRecurrenceSettlementAllowed,
  FinanceConflictError,
  FinanceService,
} from "../src/finance-service.js";
import { decodeCursor, InvalidCursorError } from "../src/http/cursor.js";

describe("finance command guards", () => {
  it("previews a batch reclassification and reports an ineligible transaction without mutating", async () => {
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const categoryId = "0190f3c8-2a10-7abc-8def-1234567890ae";
    const transactionId = "0190f3c8-2a10-7abc-8def-1234567890af";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes("FROM finance_category"))
          return { rows: [{ id: categoryId, kind: "expense", archived: false, version: 2 }] };
        if (sql.includes("FROM finance_transaction"))
          return {
            rows: [
              {
                id: transactionId,
                workspace_id: workspaceId,
                kind: "expense",
                state: "posted",
                amount_minor: "100",
                settled_minor: "100",
                currency_code: "BRL",
                occurred_on: "2026-08-24",
                due_on: null,
                posted_on: null,
                description: "Mercado",
                category_id: "0190f3c8-2a10-7abc-8def-1234567890b0",
                card_id: null,
                statement_id: null,
                recurrence_id: null,
                installment_plan_id: null,
                version: 1,
              },
            ],
          };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const preview = await service.previewTransactionReclassification(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "viewer",
      },
      { categoryId, transactions: [{ id: transactionId, version: 0 }] },
    );
    expect(preview.canConfirm).toBe(false);
    expect(preview.rows[0]?.errors).toContain("A transação foi alterada desde a prévia.");
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE finance_transaction")),
    ).toBe(false);
  });

  it("reclassifies the whole batch atomically and audits sanitized category transitions", async () => {
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const categoryId = "0190f3c8-2a10-7abc-8def-1234567890ae";
    const transactionId = "0190f3c8-2a10-7abc-8def-1234567890af";
    const source = {
      id: transactionId,
      workspace_id: workspaceId,
      kind: "expense",
      state: "posted",
      amount_minor: "100",
      settled_minor: "100",
      currency_code: "BRL",
      occurred_on: "2026-08-24",
      due_on: null,
      posted_on: null,
      description: "sensível",
      category_id: null,
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      installment_plan_id: null,
      version: 1,
    };
    const changed = { ...source, category_id: categoryId, version: 2 };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"'))
          return { rowCount: 1, rows: [{ id: "idem-reclass" }] };
        if (sql.includes("FROM finance_category"))
          return { rows: [{ id: categoryId, kind: "expense", archived: false, version: 2 }] };
        if (sql.includes("UPDATE finance_transaction")) return { rows: [changed] };
        if (sql.includes("FROM finance_transaction")) return { rows: [source] };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        if (sql.includes('UPDATE "idempotency_key"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const input = { categoryId, transactions: [{ id: transactionId, version: 1 }] };
    const preview = await service.previewTransactionReclassification(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "member",
      },
      input,
    );
    const result = await service.reclassifyTransactions(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "member",
      },
      { ...input, previewHash: preview.previewHash },
      "reclass-command-1",
      preview.categoryVersion,
    );
    expect(result.committed).toBe(true);
    expect(result.transactions[0]?.categoryId).toBe(categoryId);
    expect(
      client.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE finance_transaction")),
    ).toHaveLength(1);
    const auditCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO audit_event"),
    );
    expect(auditCall?.[1]).toEqual(expect.arrayContaining(["transaction.reclassified"]));
  });
  it("paginates loan payments with a signed cursor inside the workspace", async () => {
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const loanId = "0190f3c8-2a10-7abc-8def-1234567890ac";
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes("SELECT id FROM loan_contract")) {
          expect(values?.[1]).toBeTruthy();
          return { rows: [{ id: values?.[1] as string }] };
        }
        if (sql.includes("FROM loan_payment")) {
          expect(sql).toContain("workspace_id = $1 AND loan_id = $2");
          expect(sql).toContain("ORDER BY occurred_on DESC, id DESC");
          expect(values).toEqual([workspaceId, loanId, 3]);
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890b3",
                loan_id: loanId,
                amount_minor: "300",
                currency_code: "BRL",
                occurred_on: "2026-08-23",
              },
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890b2",
                loan_id: loanId,
                amount_minor: "200",
                currency_code: "BRL",
                occurred_on: "2026-08-22",
              },
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890b1",
                loan_id: loanId,
                amount_minor: "100",
                currency_code: "BRL",
                occurred_on: "2026-08-21",
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never, {
      cursorSecret: "loan-payment-test-secret",
    });

    const page = await service.listLoanPayments(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "viewer",
      },
      loanId,
      { limit: 2 },
    );

    expect(page.items.map((payment) => payment.amount.minor)).toEqual(["300", "200"]);
    expect(page.hasMore).toBe(true);
    const nextCursor = page.nextCursor;
    expect(nextCursor).toBeTruthy();
    if (!nextCursor) throw new Error("expected a next cursor");
    expect(decodeCursor(nextCursor, "loan-payment-test-secret")).toEqual({
      ordering: "occurred_on,id:desc",
      position: [workspaceId, loanId, "2026-08-22", "0190f3c8-2a10-7abc-8def-1234567890b2"],
    });
    await expect(
      service.listLoanPayments(
        {
          workspaceId,
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "viewer",
        },
        "0190f3c8-2a10-7abc-8def-1234567890ad",
        { cursor: nextCursor, limit: 2 },
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      service.listLoanPayments(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ae",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "viewer",
        },
        loanId,
        { cursor: nextCursor, limit: 2 },
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("turns a concurrent active category name collision into a recoverable conflict", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"'))
          return { rowCount: 1, rows: [{ id: "idem-category" }] };
        if (sql.includes("INSERT INTO finance_category")) throw { code: "23505" };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    await expect(
      service.createCategory(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "member",
        },
        { name: "Mercado", kind: "expense" },
        "category-collision-001",
      ),
    ).rejects.toBeInstanceOf(FinanceConflictError);
  });

  it("maps a concurrent category rename collision to a recoverable conflict", async () => {
    const categoryId = "0190f3c8-2a10-7abc-8def-1234567890b0";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"'))
          return { rowCount: 1, rows: [{ id: "idem-category-update" }] };
        if (sql.includes("SELECT id, workspace_id, name, kind, archived, version"))
          return {
            rows: [
              {
                id: categoryId,
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                name: "Mercado",
                kind: "expense",
                archived: false,
                version: 0,
              },
            ],
          };
        if (sql.includes("FROM finance_category") && sql.includes("lower(name)"))
          return { rows: [] };
        if (sql.includes("UPDATE finance_category")) throw { code: "23505" };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    await expect(
      service.updateCategory(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "member",
        },
        categoryId,
        { name: "Feira" },
        "category-update-collision-001",
        0,
      ),
    ).rejects.toBeInstanceOf(FinanceConflictError);
  });

  it("updates a category atomically and records its redacted audit transition", async () => {
    const categoryId = "0190f3c8-2a10-7abc-8def-1234567890b0";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE")) return { rows: [] };
        if (sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"'))
          return { rowCount: 1, rows: [{ id: "idem-1" }] };
        if (sql.includes("SELECT id, workspace_id, name, kind, archived, version"))
          return {
            rows: [
              {
                id: categoryId,
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                name: "Mercado",
                kind: "expense",
                archived: false,
                version: 0,
              },
            ],
          };
        if (sql.includes("FROM finance_category") && sql.includes("lower(name)"))
          return { rows: [] };
        if (sql.includes("UPDATE finance_category"))
          return {
            rows: [
              {
                id: categoryId,
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                name: "Feira",
                kind: "expense",
                archived: false,
                version: 1,
              },
            ],
          };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        if (sql.includes('UPDATE "idempotency_key"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const result = await service.updateCategory(
      {
        workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "member",
      },
      categoryId,
      { name: "Feira" },
      "category-service-test-001",
      0,
    );

    expect(result).toEqual({
      replayed: false,
      category: {
        id: categoryId,
        workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
        name: "Feira",
        kind: "expense",
        archived: false,
        version: 1,
      },
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_event"),
      expect.arrayContaining(["category.updated"]),
    );
  });

  it("does not accept an adjustment through the generic transaction command", async () => {
    const service = new FinanceService({} as never);
    await expect(
      service.createTransaction(
        {
          workspaceId: "workspace",
          actorId: "actor",
          correlationId: "correlation",
          role: "member",
        },
        { kind: "adjustment", amount: { currency: "BRL", minor: "100" } },
        "adjustment-command-test-001",
      ),
    ).rejects.toThrow("Ajustes exigem o comando de conferência");
  });

  it("edits a planned wallet transaction with optimistic concurrency and audit", async () => {
    const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const current = {
      id: transactionId,
      workspace_id: workspaceId,
      kind: "expense",
      state: "planned",
      amount_minor: "1000",
      settled_minor: "0",
      currency_code: "BRL",
      occurred_on: "2028-02-01",
      due_on: "2028-02-05",
      posted_on: null,
      description: "Mercado",
      category_id: "0190f3c8-2a10-7abc-8def-1234567890b2",
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      installment_plan_id: null,
      version: 0,
    };
    const updated = {
      ...current,
      amount_minor: "1250",
      occurred_on: "2028-02-02",
      due_on: null,
      description: "Feira",
      version: 1,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return { rows: [current] };
        if (sql.includes("FROM workspace_preference p"))
          return { rows: [{ currency_code: "BRL" }] };
        if (sql.startsWith("UPDATE finance_transaction")) return { rows: [updated] };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        if (sql.includes('UPDATE "idempotency_key"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const result = await service.updateTransaction(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "member",
      },
      transactionId,
      {
        amount: { currency: "BRL", minor: "1250" },
        occurredOn: "2028-02-02",
        dueOn: null,
        description: "Feira",
      },
      "transaction-edit-service-001",
      0,
    );

    expect(result).toEqual({
      replayed: false,
      transaction: expect.objectContaining({
        id: transactionId,
        amount: { currency: "BRL", minor: "1250" },
        occurredOn: "2028-02-02",
        dueOn: null,
        description: "Feira",
        version: 1,
      }),
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_event"),
      expect.arrayContaining(["transaction.updated"]),
    );
  });

  it("rejects economic edits after a transaction has published", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ac",
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                kind: "expense",
                state: "posted",
                amount_minor: "1000",
                settled_minor: "1000",
                currency_code: "BRL",
                occurred_on: "2028-02-01",
                due_on: null,
                posted_on: "2028-02-01T12:00:00.000Z",
                description: "Mercado",
                category_id: null,
                card_id: null,
                statement_id: null,
                recurrence_id: null,
                installment_plan_id: null,
                version: 2,
              },
            ],
          };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    await expect(
      service.updateTransaction(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "member",
        },
        "0190f3c8-2a10-7abc-8def-1234567890ac",
        { amount: { currency: "BRL", minor: "1100" } },
        "transaction-edit-posted-001",
        2,
      ),
    ).rejects.toThrow("só podem");
  });

  it("rejects direct edits to installment occurrences", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ac",
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                kind: "expense",
                state: "planned",
                amount_minor: "1000",
                settled_minor: "0",
                currency_code: "BRL",
                occurred_on: "2028-02-01",
                due_on: null,
                posted_on: null,
                description: "Parcela",
                category_id: null,
                card_id: null,
                statement_id: null,
                recurrence_id: null,
                installment_plan_id: "0190f3c8-2a10-7abc-8def-1234567890b1",
                version: 0,
              },
            ],
          };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    await expect(
      service.updateTransaction(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "member",
        },
        "0190f3c8-2a10-7abc-8def-1234567890ac",
        { amount: { currency: "BRL", minor: "1100" } },
        "transaction-edit-installment-001",
        0,
      ),
    ).rejects.toThrow("parcelamento");
  });

  it("cancels a planned wallet transaction once and records an audit event", async () => {
    const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const current = {
      id: transactionId,
      workspace_id: workspaceId,
      kind: "expense",
      state: "planned",
      amount_minor: "1000",
      settled_minor: "0",
      currency_code: "BRL",
      occurred_on: "2028-02-01",
      due_on: "2028-02-05",
      posted_on: null,
      description: "Mercado",
      category_id: null,
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      installment_plan_id: null,
      version: 2,
    };
    const canceled = { ...current, state: "canceled", version: 3 };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return { rows: [current] };
        if (sql.startsWith("UPDATE finance_transaction")) return { rows: [canceled] };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        if (sql.includes('UPDATE "idempotency_key"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);

    const result = await service.cancelTransaction(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "member",
      },
      transactionId,
      "transaction-cancel-service-001",
      current.version,
    );

    expect(result).toEqual({
      replayed: false,
      transaction: expect.objectContaining({
        id: transactionId,
        state: "canceled",
        version: 3,
      }),
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_event"),
      expect.arrayContaining(["transaction.canceled"]),
    );
  });

  it("rejects cancellation of a posted transaction and leaves the ledger untouched", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ac",
                workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
                kind: "expense",
                state: "posted",
                amount_minor: "1000",
                settled_minor: "1000",
                currency_code: "BRL",
                occurred_on: "2028-02-01",
                due_on: null,
                posted_on: "2028-02-01T12:00:00.000Z",
                description: "Mercado",
                category_id: null,
                card_id: null,
                statement_id: null,
                recurrence_id: null,
                installment_plan_id: null,
                version: 2,
              },
            ],
          };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);

    await expect(
      service.cancelTransaction(
        {
          workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
          actorId: "user-1",
          correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "member",
        },
        "0190f3c8-2a10-7abc-8def-1234567890ac",
        "transaction-cancel-posted-001",
        2,
      ),
    ).rejects.toThrow("reversão");
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE finance_transaction")),
    ).toBe(false);
  });

  it("replays a transaction cancellation without a second mutation or audit", async () => {
    const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
    const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
    const current = {
      id: transactionId,
      workspace_id: workspaceId,
      kind: "expense",
      state: "planned",
      amount_minor: "1000",
      settled_minor: "0",
      currency_code: "BRL",
      occurred_on: "2028-02-01",
      due_on: "2028-02-05",
      posted_on: null,
      description: "Mercado",
      category_id: null,
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      installment_plan_id: null,
      version: 2,
    };
    const canceled = { ...current, state: "canceled", version: 3 };
    let inserted = true;
    let requestHash = "";
    let response: unknown = null;
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.startsWith("SET LOCAL ROLE") || sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) {
          if (!inserted) return { rowCount: 0, rows: [] };
          inserted = false;
          requestHash = String(values?.[2]);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SELECT request_hash, status_code, response")) {
          return { rows: [{ request_hash: requestHash, status_code: 200, response }] };
        }
        if (sql.startsWith('UPDATE "idempotency_key"')) {
          response = values?.[3];
          return { rows: [] };
        }
        if (sql.includes("FROM finance_transaction") && sql.includes("FOR UPDATE"))
          return { rows: [current] };
        if (sql.startsWith("UPDATE finance_transaction")) return { rows: [canceled] };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const scope = {
      workspaceId,
      actorId: "user-1",
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      role: "member" as const,
    };

    const first = await service.cancelTransaction(
      scope,
      transactionId,
      "transaction-cancel-retry-001",
      2,
    );
    const replay = await service.cancelTransaction(
      scope,
      transactionId,
      "transaction-cancel-retry-001",
      2,
    );

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ replayed: true, transaction: first.transaction });
    expect(
      client.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith("UPDATE finance_transaction"),
      ),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO audit_event")),
    ).toHaveLength(1);
  });

  it("only reopens a closed statement that has no payments", () => {
    expect(() => assertStatementCanReopen({ state: "closed", paidMinor: 0n })).not.toThrow();
    expect(() => assertStatementCanReopen({ state: "partially_paid", paidMinor: 100n })).toThrow(
      "pagamentos",
    );
    expect(() => assertStatementCanReopen({ state: "paid", paidMinor: 100n })).toThrow(
      "pagamentos",
    );
    expect(() => assertStatementCanReopen({ state: "open", paidMinor: 0n })).toThrow(
      "Somente uma fatura fechada",
    );
  });

  it("requires an effective amount only for variable recurrence settlement", () => {
    expect(() => assertVariableRecurrenceSettlementAllowed(true, false)).toThrow("valor efetivo");
    expect(() => assertVariableRecurrenceSettlementAllowed(true, true)).not.toThrow();
    expect(() => assertVariableRecurrenceSettlementAllowed(false, false)).not.toThrow();
  });

  it("updates only supplied card fields and increments its version", async () => {
    const current = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ad",
      workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
      name: "Principal",
      closing_day: 10,
      due_day: 17,
      holder: "Marina",
      last_four: "1234",
      limit_minor: "100000",
      currency_code: "BRL",
      archived: false,
      version: 3,
    };
    const updated = { ...current, closing_day: 31, holder: null, version: 4 };
    const client = {
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM credit_card") && sql.includes("FOR UPDATE")) {
          return { rows: [current] };
        }
        if (sql.startsWith("UPDATE credit_card")) return { rows: [updated] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);
    const result = await service.updateCard(
      {
        workspaceId: current.workspace_id,
        actorId: "user-1",
        correlationId: "correlation-1",
        role: "member",
      },
      current.id,
      { closingDay: 31, holder: null },
      "card-update-service-001",
      3,
    );

    expect(result.card).toMatchObject({ closingDay: 31, holder: null, version: 4 });
    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE credit_card"),
    );
    expect(updateCall?.[1]).toEqual([
      current.workspace_id,
      current.id,
      current.name,
      31,
      current.due_day,
      null,
      current.last_four,
      current.limit_minor,
      3,
    ]);
  });

  it("blocks a cycle-rule change when an open statement already has a purchase", async () => {
    const current = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ad",
      workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
      name: "Principal",
      closing_day: 10,
      due_day: 17,
      holder: null,
      last_four: null,
      limit_minor: null,
      currency_code: "BRL",
      archived: false,
      version: 0,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM credit_card") && sql.includes("FOR UPDATE")) {
          return { rows: [current] };
        }
        if (sql.includes("FROM credit_statement") && sql.includes("t.statement_id = s.id")) {
          return { rows: [{ blocked: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);

    await expect(
      service.updateCard(
        {
          workspaceId: current.workspace_id,
          actorId: "user-1",
          correlationId: "correlation-1",
          role: "member",
        },
        current.id,
        { closingDay: 31 },
        "card-update-cycle-guard-001",
        current.version,
      ),
    ).rejects.toThrow("fatura aberta");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE credit_card"))).toBe(
      false,
    );
    expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });

  it("blocks card archive while a statement has an open balance", async () => {
    const current = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ad",
      workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
      name: "Principal",
      closing_day: 10,
      due_day: 17,
      holder: null,
      last_four: null,
      limit_minor: null,
      currency_code: "BRL",
      archived: false,
      version: 0,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO "idempotency_key"')) return { rowCount: 1, rows: [] };
        if (sql.includes("FROM credit_card") && sql.includes("FOR UPDATE")) {
          return { rows: [current] };
        }
        if (sql.includes("SELECT EXISTS")) return { rows: [{ blocked: true }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new FinanceService({ connect: vi.fn(async () => client) } as never);

    await expect(
      service.archiveCard(
        {
          workspaceId: current.workspace_id,
          actorId: "user-1",
          correlationId: "correlation-1",
          role: "member",
        },
        current.id,
        "card-archive-service-001",
        0,
      ),
    ).rejects.toThrow("fatura antes de arquivar");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE credit_card"))).toBe(
      false,
    );
    expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });

  it("pages statement composition by a stable date, creation time, and id cursor", async () => {
    const itemOne = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ac",
      statement_id: "0190f3c8-2a10-7abc-8def-1234567890ae",
      state: "posted" as const,
      description: "Primeira compra",
      occurred_on: "2026-08-23",
      created_at: new Date("2026-08-23T12:00:00.000Z"),
      amount_minor: "100",
      currency_code: "BRL",
      payment_id: null,
    };
    const itemTwo = {
      ...itemOne,
      id: "0190f3c8-2a10-7abc-8def-1234567890af",
      description: "Segunda compra",
      created_at: new Date("2026-08-23T12:01:00.000Z"),
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM credit_statement")) {
          return { rows: [{ id: itemOne.statement_id }] };
        }
        if (sql.includes("SELECT t.id")) {
          return { rows: [itemOne, itemTwo] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const service = new FinanceService(pool as never, {
      cursorSecret: "test-secret-that-is-long-enough",
    });
    const scope = {
      workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
      actorId: "user-1",
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      role: "member" as const,
    };

    const first = await service.listStatementItems(scope, itemOne.statement_id, { limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.description).toBe("Primeira compra");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor ?? "", "test-secret-that-is-long-enough")).toEqual({
      ordering: "occurred_on,created_at,id",
      position: ["2026-08-23", "2026-08-23T12:00:00.000Z", itemOne.id],
    });

    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM credit_statement")) {
        return { rows: [{ id: itemOne.statement_id }] };
      }
      if (sql.includes("SELECT t.id")) return { rows: [itemTwo] };
      return { rows: [] };
    });
    const second = await service.listStatementItems(scope, itemOne.statement_id, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.items[0]?.description).toBe("Segunda compra");
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const itemQuery = client.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => typeof sql === "string" && sql.includes("SELECT t.id"))
      .at(-1);
    expect(itemQuery).toContain("t.created_at > $4::timestamptz");
    expect(itemQuery).toContain("LIMIT $6");
  });

  it("filters and pages the timeline with a stable descending cursor", async () => {
    const transactionOne = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ac",
      workspace_id: "0190f3c8-2a10-7abc-8def-1234567890ab",
      kind: "expense",
      state: "posted",
      amount_minor: "100",
      settled_minor: "100",
      currency_code: "BRL",
      occurred_on: "2026-08-23",
      due_on: null,
      posted_on: new Date("2026-08-23T12:00:00.000Z"),
      description: "Mercado",
      category_id: null,
      card_id: null,
      statement_id: null,
      recurrence_id: null,
      created_at: new Date("2026-08-23T12:00:00.000Z"),
      version: 0,
    };
    const transactionTwo = {
      ...transactionOne,
      id: "0190f3c8-2a10-7abc-8def-1234567890ad",
      description: "Mercado 2",
      created_at: new Date("2026-08-23T12:01:00.000Z"),
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id, workspace_id, kind")) {
          return { rows: [transactionTwo, transactionOne] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const service = new FinanceService(pool as never, {
      cursorSecret: "test-secret-that-is-long-enough",
    });
    const scope = {
      workspaceId: transactionOne.workspace_id,
      actorId: "user-1",
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      role: "member" as const,
    };

    const first = await service.listTransactions(scope, {
      search: "mercado",
      from: "2026-08-01",
      to: "2026-08-31",
      kind: "expense",
      limit: 1,
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.description).toBe("Mercado 2");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const firstQuery = client.query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("ORDER BY occurred_on DESC"));
    expect(firstQuery).toContain("t.description ILIKE");
    expect(firstQuery).toContain("t.occurred_on >=");
    expect(firstQuery).toContain("t.kind =");

    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, workspace_id, kind")) return { rows: [transactionOne] };
      return { rows: [] };
    });
    const second = await service.listTransactions(scope, {
      search: "mercado",
      from: "2026-08-01",
      to: "2026-08-31",
      kind: "expense",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items[0]?.description).toBe("Mercado");
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const secondQuery = client.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => typeof sql === "string" && sql.includes("ORDER BY occurred_on DESC"))
      .at(-1);
    expect(secondQuery).toContain("t.created_at <");
  });
});
