import { describe, expect, it } from "vitest";

import { FinanceService, redactFinanceAuditSnapshot } from "../src/finance-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
const auditId = "0190f3c8-2a10-7abc-8def-1234567890ad";

function fakePool(rows: Array<Record<string, unknown>>) {
  let rowIndex = 0;
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (/^SELECT id FROM finance_transaction/.test(text)) {
        return { rows: [{ id: transactionId }] };
      }
      if (/^SELECT id, target_id AS transaction_id/.test(text)) {
        if (text.includes("LIMIT")) return { rows };
        return { rows: rows[rowIndex++] ? [rows[rowIndex - 1]] : [] };
      }
      if (/^SELECT id, event_type/.test(text)) {
        return { rows: rows[rowIndex++] ? [rows[rowIndex - 1]] : [] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return {
    queries,
    pool: { connect: async () => client },
  };
}

describe("finance transaction audit history", () => {
  it("redacts snapshots on both write and read boundaries", () => {
    expect(
      redactFinanceAuditSnapshot({
        kind: "expense",
        state: "posted",
        categoryId: "0190f3c8-2a10-7abc-8def-1234567890ae",
        cardId: null,
        statementId: null,
        version: 2,
        amountMinor: "999999",
        description: "segredo",
        actorEmail: "private@example.test",
        nested: { token: "secret" },
      }),
    ).toEqual({
      kind: "expense",
      state: "posted",
      categoryId: "0190f3c8-2a10-7abc-8def-1234567890ae",
      cardId: null,
      statementId: null,
      version: 2,
    });
    expect(redactFinanceAuditSnapshot(["not", "an", "object"])).toBeNull();
    expect(redactFinanceAuditSnapshot({ version: "2", state: { secret: true } })).toEqual({});
  });

  it("lists scoped audit events with a signed cursor and redacted snapshots", async () => {
    const fake = fakePool([
      {
        id: auditId,
        transaction_id: transactionId,
        category: "finance",
        action: "transaction.created",
        actor_id: "user-1",
        occurred_at: new Date("2026-08-23T12:00:00.000Z"),
        origin: "api",
        correlation_id: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        result: "success",
        reason: null,
        before_redacted: null,
        after_redacted: { state: "posted", kind: "expense", amountMinor: "999999" },
      },
    ]);
    const cursorSecret = "test-secret-that-is-long-enough";
    const service = new FinanceService(fake.pool as never, { cursorSecret });

    const page = await service.listTransactionAudit(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        role: "member",
      },
      transactionId,
      { limit: 10 },
    );

    expect(page.items[0]).toMatchObject({
      id: auditId,
      transactionId,
      category: "finance",
      action: "transaction.created",
      actorId: "user-1",
      origin: "api",
      correlationId: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
      result: "success",
      reason: null,
      before: null,
      after: { state: "posted", kind: "expense" },
    });
    expect(page.nextCursor).toBeNull();
    expect(fake.queries.join("\n")).toContain("target_type = 'finance_transaction'");
    expect(fake.queries.join("\n")).toContain("ORDER BY occurred_at DESC, id DESC");
  });

  it("reapplies the redaction allowlist when reading persisted snapshots", async () => {
    const fake = fakePool([
      {
        id: auditId,
        transaction_id: transactionId,
        category: "finance",
        action: "transaction.created",
        actor_id: "user-1",
        occurred_at: new Date("2026-08-23T12:00:00.000Z"),
        origin: "api",
        correlation_id: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        result: "success",
        reason: null,
        before_redacted: { description: "segredo", amountMinor: "1000" },
        after_redacted: { state: "posted", amountMinor: "1000", cardId: null },
      },
    ]);
    const service = new FinanceService(fake.pool as never, {
      cursorSecret: "test-secret-that-is-long-enough",
    });

    await expect(
      service.getTransactionAudit(
        {
          workspaceId,
          actorId: "user-1",
          correlationId: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
          role: "viewer",
        },
        transactionId,
        auditId,
      ),
    ).resolves.toMatchObject({
      before: {},
      after: { state: "posted", cardId: null },
    });
  });

  it("returns one event with only same-transaction ledger consequences", async () => {
    const fake = fakePool([
      {
        id: auditId,
        transaction_id: transactionId,
        category: "finance",
        action: "transaction.reversed",
        actor_id: "user-1",
        occurred_at: new Date("2026-08-23T13:00:00.000Z"),
        origin: "api",
        correlation_id: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        result: "success",
        reason: "Correção solicitada",
        before_redacted: { state: "posted", version: 0 },
        after_redacted: { state: "canceled", version: 1 },
      },
      {
        id: "0190f3c8-2a10-7abc-8def-1234567890ae",
        event_type: "transaction.reversed.v1",
        status: "published",
        occurred_on: "2026-08-23",
        published_at: new Date("2026-08-23T13:00:00.000Z"),
        reversed_event_id: "0190f3c8-2a10-7abc-8def-1234567890af",
      },
    ]);
    const cursorSecret = "test-secret-that-is-long-enough";
    const service = new FinanceService(fake.pool as never, { cursorSecret });

    await expect(
      service.getTransactionAudit(
        {
          workspaceId,
          actorId: "user-1",
          correlationId: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
          role: "viewer",
        },
        transactionId,
        auditId,
      ),
    ).resolves.toMatchObject({
      id: auditId,
      transactionId,
      consequences: {
        ledgerEvents: [
          {
            eventType: "transaction.reversed.v1",
            status: "published",
            reversedEventId: "0190f3c8-2a10-7abc-8def-1234567890af",
          },
        ],
      },
    });
  });

  it("keeps microseconds in the signed audit cursor position", async () => {
    const fake = fakePool([
      {
        id: auditId,
        transaction_id: transactionId,
        category: "finance",
        action: "transaction.created",
        actor_id: "user-1",
        occurred_at: "2026-08-23 12:00:00.123456+00",
        origin: "api",
        correlation_id: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        result: "success",
        reason: null,
        before_redacted: null,
        after_redacted: { state: "posted" },
      },
      {
        id: "0190f3c8-2a10-7abc-8def-1234567890ae",
        transaction_id: transactionId,
        category: "finance",
        action: "transaction.posted",
        actor_id: "user-1",
        occurred_at: "2026-08-23 12:00:00.123100+00",
        origin: "api",
        correlation_id: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        result: "success",
        reason: null,
        before_redacted: null,
        after_redacted: { state: "posted" },
      },
    ]);
    const cursorSecret = "test-secret-that-is-long-enough";
    const service = new FinanceService(fake.pool as never, { cursorSecret });
    const page = await service.listTransactionAudit(
      {
        workspaceId,
        actorId: "user-1",
        correlationId: "01J5Q5M3GJ6R3S6T4Q1W8Z2K9A",
        role: "member",
      },
      transactionId,
      { limit: 1 },
    );
    expect(page.nextCursor).toBeTruthy();
    const { decodeCursor } = await import("../src/http/cursor.js");
    expect(decodeCursor(page.nextCursor as string, cursorSecret).position).toEqual([
      "2026-08-23T12:00:00.123456+00:00",
      auditId,
    ]);
  });
});
