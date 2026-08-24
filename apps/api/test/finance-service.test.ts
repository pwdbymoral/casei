import { describe, expect, it, vi } from "vitest";

import { assertStatementCanReopen, FinanceService } from "../src/finance-service.js";
import { decodeCursor } from "../src/http/cursor.js";

describe("finance command guards", () => {
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
