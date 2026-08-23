import { describe, expect, it, vi } from "vitest";

import {
  createFixtureFinanceAdapter,
  createHttpFinanceAdapter,
  createRequestGuard,
} from "./finance";

describe("finance adapter", () => {
  it("sends idempotent transaction commands to the versioned API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.credentials).toBe("include");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^web-/);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        kind: "expense",
        amount: { currency: "BRL", minor: "1200" },
      });
      return new Response(
        JSON.stringify({
          id: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a299",
          workspaceId: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
          kind: "expense",
          state: "posted",
          amount: { currency: "BRL", minor: "1200" },
          settledAmount: { currency: "BRL", minor: "1200" },
          occurredOn: "2026-08-23",
          dueOn: null,
          postedOn: "2026-08-23T12:00:00.000Z",
          description: "Feira",
          categoryId: null,
          cardId: null,
          statementId: null,
          version: 0,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const transaction = await adapter.createTransaction("workspace", {
      kind: "expense",
      amount: { currency: "BRL", minor: "1200" },
      description: "Feira",
    });
    expect(transaction.description).toBe("Feira");
    expect(fetch).toHaveBeenCalledWith("/v1/workspaces/workspace/transactions", expect.any(Object));
  });

  it("keeps fixture writes in the same adapter for quick capture", async () => {
    const adapter = createFixtureFinanceAdapter();
    const before = await adapter.listTransactions("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201");
    await adapter.createTransaction("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201", {
      kind: "expense",
      amount: { currency: "BRL", minor: "2500" },
    });
    const after = await adapter.listTransactions("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201");
    expect(after).toHaveLength(before.length + 1);
  });

  it("uses version preconditions for explicit statement reopening", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v3"');
      expect(JSON.parse(String(init?.body))).toEqual({ confirm: true });
      return new Response(
        JSON.stringify({
          id: "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211",
          workspaceId: "workspace",
          cardId: "card",
          periodStart: "2026-08-11",
          closingOn: "2026-09-10",
          dueOn: "2026-09-17",
          state: "open",
          total: { currency: "BRL", minor: "2500" },
          paid: { currency: "BRL", minor: "0" },
          openAmount: { currency: "BRL", minor: "2500" },
          version: 4,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    await adapter.reopenStatement("workspace", {
      id: "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211",
      workspaceId: "workspace",
      cardId: "card",
      periodStart: "2026-08-11",
      closingOn: "2026-09-10",
      dueOn: "2026-09-17",
      state: "closed",
      total: { currency: "BRL", minor: "2500" },
      paid: { currency: "BRL", minor: "0" },
      openAmount: { currency: "BRL", minor: "2500" },
      version: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/workspaces/workspace/statements/019b5d9e-3c12-7a11-8d47-7b5b5dd7a211/reopen",
      expect.any(Object),
    );
  });

  it("preserves the current version from a conflict response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            message: "O recurso foi alterado.",
            currentVersion: 4,
          },
        },
        { status: 412 },
      ),
    );
    const adapter = createHttpFinanceAdapter({ fetch });
    await expect(
      adapter.reopenStatement("workspace", {
        id: "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211",
        workspaceId: "workspace",
        cardId: "card",
        periodStart: "2026-08-11",
        closingOn: "2026-09-10",
        dueOn: "2026-09-17",
        state: "closed",
        total: { currency: "BRL", minor: "2500" },
        paid: { currency: "BRL", minor: "0" },
        openAmount: { currency: "BRL", minor: "2500" },
        version: 3,
      }),
    ).rejects.toMatchObject({ status: 412, currentVersion: 4 });
  });

  it("invalidates stale statement composition requests", () => {
    const guard = createRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });
});
