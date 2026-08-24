import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canWriteFinance,
  clearTransactionQueryParams,
  createFixtureFinanceAdapter,
  createHttpFinanceAdapter,
  createQuickCaptureTransactionInput,
  createRequestGuard,
  createWorkspaceGenerationGuard,
  FinanceAdapterError,
  financeAdapterForEnvironment,
  hasTransactionQueryFilters,
  mergeTransactionPage,
  shouldRetryIdempotentCommand,
  statementItemAmountPrefix,
  type Transaction,
  transactionAmountPrefix,
  transactionCardIdForKind,
  transactionKindLabel,
  transactionQueryFromSearchParams,
  unauthenticatedFinanceAdapter,
} from "./finance";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("finance adapter", () => {
  it("uses fixtures only when explicitly enabled and otherwise denies without an API origin", async () => {
    vi.stubEnv("CASEI_UI_FIXTURES", "");
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    expect(financeAdapterForEnvironment()).toBe(unauthenticatedFinanceAdapter);
    await expect(financeAdapterForEnvironment().listCards("workspace")).rejects.toMatchObject({
      status: 401,
    });

    vi.stubEnv("CASEI_UI_FIXTURES", "1");
    expect(
      await financeAdapterForEnvironment().listCards("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201"),
    ).toEqual(expect.any(Array));
  });

  it("uses the canonical API origin for authenticated finance requests", async () => {
    vi.stubEnv("CASEI_UI_FIXTURES", "");
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "https://api.example.test/");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(input).toBe("https://api.example.test/v1/workspaces/workspace/cards");
      return Response.json({ items: [], page: { nextCursor: null, hasMore: false } });
    });
    // The environment-selected adapter is HTTP; replace the global boundary only for this test.
    vi.stubGlobal("fetch", fetch);
    const adapter = financeAdapterForEnvironment();
    await expect(adapter.listCards("workspace")).resolves.toEqual([]);
  });

  it.each([
    ["owner", true],
    ["member", true],
    ["viewer", false],
  ] as const)("maps the %s workspace role to finance write access", (role, allowed) => {
    // Keep this assertion close to the adapter contract consumed by the authenticated shell.
    expect(canWriteFinance(role)).toBe(allowed);
  });

  it("sends idempotent transaction commands to the versioned API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.credentials).toBe("include");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^web-/);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        kind: "expense",
        amount: { currency: "BRL", minor: "1200" },
      });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("occurredOn");
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

  it("reuses the logical idempotency key after a network failure", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) throw new TypeError("network interrupted");
      return Response.json(
        {
          id: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a299",
          workspaceId: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
          kind: "expense",
          state: "posted",
          amount: { currency: "USD", minor: "1200" },
          settledAmount: { currency: "USD", minor: "1200" },
          occurredOn: "2026-08-23",
          dueOn: null,
          postedOn: "2026-08-23T12:00:00.000Z",
          description: "Coffee",
          categoryId: null,
          cardId: null,
          statementId: null,
          version: 0,
        },
        { status: 201 },
      );
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const input = { kind: "expense" as const, amount: { currency: "USD", minor: "1200" } };

    await expect(
      adapter.createTransaction("workspace", input, "logical-command-001"),
    ).rejects.toThrow("network interrupted");
    await expect(
      adapter.createTransaction("workspace", input, "logical-command-001"),
    ).resolves.toMatchObject({
      amount: { currency: "USD" },
    });
    expect(keys).toEqual(["logical-command-001", "logical-command-001"]);
  });

  it("keeps the same key available for a server-error retry", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1)
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      return Response.json({ id: "transaction-after-retry" }, { status: 201 });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const input = { kind: "expense" as const, amount: { currency: "BRL", minor: "100" } };

    await expect(
      adapter.createTransaction("workspace", input, "logical-command-002"),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      adapter.createTransaction("workspace", input, "logical-command-002"),
    ).resolves.toMatchObject({
      id: "transaction-after-retry",
    });
    expect(keys).toEqual(["logical-command-002", "logical-command-002"]);
  });

  it("sends an explicit idempotency key when reversing a transaction", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("reverse-command-001");
      return Response.json({ id: "transaction-reversed", state: "canceled" });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const transaction = { id: "transaction-1", version: 2 } as Transaction;

    await expect(
      adapter.reverseTransaction("workspace", transaction, "reverse-command-001"),
    ).resolves.toMatchObject({ id: "transaction-reversed", state: "canceled" });
  });

  it("serializes timeline filters and cursor in the API request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(input).toBe(
        "/v1/workspaces/workspace/transactions?cursor=cursor-1&limit=25&search=mercado&from=2026-08-01&to=2026-08-31&state=posted&kind=expense&cardId=card-1",
      );
      return Response.json({ items: [], page: { nextCursor: null, hasMore: false } });
    });
    const adapter = createHttpFinanceAdapter({ fetch });

    await expect(
      adapter.listTransactions("workspace", {
        cursor: "cursor-1",
        limit: 25,
        search: "mercado",
        from: "2026-08-01",
        to: "2026-08-31",
        state: "posted",
        kind: "expense",
        cardId: "card-1",
      }),
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("loads transaction audit list and detail through scoped API paths", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes("/audit/")) {
        return Response.json({
          id: "0190f3c8-2a10-7abc-8def-1234567890ad",
          transactionId: "0190f3c8-2a10-7abc-8def-1234567890ac",
          action: "transaction.created",
          consequences: { ledgerEvents: [] },
        });
      }
      expect(input).toBe(
        "/v1/workspaces/workspace/transactions/transaction/audit?cursor=cursor-1&limit=10",
      );
      return Response.json({ items: [], page: { nextCursor: "next", hasMore: true } });
    });
    const adapter = createHttpFinanceAdapter({ fetch });

    await expect(
      adapter.listTransactionAudit("workspace", "transaction", {
        cursor: "cursor-1",
        limit: 10,
      }),
    ).resolves.toEqual({ items: [], nextCursor: "next", hasMore: true });
    await expect(
      adapter.getTransactionAudit("workspace", "transaction", "audit"),
    ).resolves.toMatchObject({ action: "transaction.created" });
  });

  it("keeps timeline filters in URL parameters and appends the next page", () => {
    const query = transactionQueryFromSearchParams(
      new URLSearchParams(
        "search=mercado&from=2026-08-01&state=posted&cursor=cursor-2&cardId=card-1",
      ),
    );
    expect(query).toEqual({
      search: "mercado",
      from: "2026-08-01",
      state: "posted",
      cursor: "cursor-2",
      cardId: "card-1",
    });
    expect(hasTransactionQueryFilters({ cardId: "card-1" })).toBe(true);

    const first = { id: "first" } as never;
    const second = { id: "second" } as never;
    expect(
      mergeTransactionPage([first], { items: [second], nextCursor: null, hasMore: false }, true),
    ).toEqual([first, second]);
    expect(
      mergeTransactionPage([first], { items: [second], nextCursor: null, hasMore: false }, false),
    ).toEqual([second]);
    expect(shouldRetryIdempotentCommand(new TypeError("network"))).toBe(true);
    expect(shouldRetryIdempotentCommand(new FinanceAdapterError("server", 500))).toBe(true);
    expect(shouldRetryIdempotentCommand(new FinanceAdapterError("invalid", 422))).toBe(false);
  });

  it("clears every timeline filter, including a card filter, without touching other URL state", () => {
    const params = clearTransactionQueryParams(
      new URLSearchParams("tab=timeline&search=mercado&cardId=card-1&cursor=cursor-2"),
    );

    expect(params.toString()).toBe("tab=timeline");
    expect(params.has("cardId")).toBe(false);
  });

  it("keeps fixture writes in the same adapter for quick capture", async () => {
    const adapter = createFixtureFinanceAdapter();
    const before = await adapter.listTransactions("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201");
    const created = await adapter.createTransaction("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201", {
      kind: "expense",
      amount: { currency: "BRL", minor: "2500" },
    });
    const after = await adapter.listTransactions("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201");
    expect(after.items).toHaveLength(before.items.length + 1);
    await expect(
      adapter.reverseTransaction("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201", created),
    ).resolves.toMatchObject({ id: created.id, state: "canceled" });
  });

  it("reuses an explicit reverse key and updates the fixture invoice totals", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const cardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
    const created = await adapter.createTransaction(
      workspaceId,
      {
        kind: "expense",
        amount: { currency: "BRL", minor: "2500" },
        cardId,
      },
      "fixture-card-purchase",
    );
    await expect(adapter.listStatements(workspaceId, cardId)).resolves.toMatchObject([
      { total: { minor: "2500" }, openAmount: { minor: "2500" } },
    ]);

    const reversed = await adapter.reverseTransaction(workspaceId, created, "fixture-reverse-1");
    const replay = await adapter.reverseTransaction(workspaceId, created, "fixture-reverse-1");
    expect(replay).toEqual(reversed);
    expect(reversed.state).toBe("canceled");
    await expect(adapter.listStatements(workspaceId, cardId)).resolves.toMatchObject([
      { total: { minor: "0" }, openAmount: { minor: "0" } },
    ]);
  });

  it("keeps the new workspace empty when an old response arrives after a failed load", async () => {
    const guard = createWorkspaceGenerationGuard("workspace-a");
    let resolveOldResponse!: (items: string[]) => void;
    const oldResponse = new Promise<string[]>((resolve) => {
      resolveOldResponse = resolve;
    });
    const oldRequest = guard.begin("workspace-a");
    const visibleItems: string[] = [];

    guard.switchWorkspace("workspace-b");
    const newRequest = guard.begin("workspace-b");
    try {
      throw new Error("new workspace unavailable");
    } catch {
      if (guard.isCurrent(newRequest)) visibleItems.length = 0;
    }
    resolveOldResponse(["old-workspace-item"]);
    const oldItems = await oldResponse;
    if (guard.isCurrent(oldRequest)) visibleItems.push(...oldItems);

    expect(visibleItems).toEqual([]);
    expect(guard.isCurrent(oldRequest)).toBe(false);
  });

  it("keeps fixture data isolated by workspace and replays a transaction command", async () => {
    const adapter = createFixtureFinanceAdapter();
    const firstWorkspace = "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202";
    const secondWorkspace = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const input = createQuickCaptureTransactionInput({
      kind: "income",
      amountMinor: "1200",
      currency: "USD",
      planned: false,
      description: "Freela",
      cardId: "",
    });

    const created = await adapter.createTransaction(firstWorkspace, input, "fixture-command-1");
    const replay = await adapter.createTransaction(firstWorkspace, input, "fixture-command-1");
    expect(replay).toEqual(created);
    await expect(
      adapter.createTransaction(
        firstWorkspace,
        { ...input, amount: { ...input.amount, minor: "1300" } },
        "fixture-command-1",
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(adapter.listTransactions(firstWorkspace)).resolves.toMatchObject({
      items: [expect.objectContaining({ workspaceId: firstWorkspace })],
    });
    await expect(adapter.listTransactions(secondWorkspace)).resolves.toMatchObject({
      items: [],
    });
  });

  it("builds USD capture input and never carries a card into income", () => {
    expect(
      createQuickCaptureTransactionInput({
        kind: "income",
        amountMinor: "1200",
        currency: "USD",
        planned: false,
        description: "Freela",
        cardId: "card-1",
      }),
    ).toEqual({
      kind: "income",
      amount: { currency: "USD", minor: "1200" },
      state: "posted",
      description: "Freela",
      cardId: null,
    });
    expect(transactionCardIdForKind("income", "card-1")).toBeNull();
    expect(transactionCardIdForKind("expense", "card-1")).toBe("card-1");
  });

  it("labels every timeline kind and uses a non-expense sign for transfers and adjustments", () => {
    expect(transactionKindLabel({ kind: "income", cardId: null })).toBe("Receita");
    expect(transactionKindLabel({ kind: "expense", cardId: null })).toBe("Despesa");
    expect(transactionKindLabel({ kind: "expense", cardId: "card-1" })).toBe("Compra no cartão");
    expect(transactionKindLabel({ kind: "transfer", cardId: null })).toBe("Transferência");
    expect(transactionKindLabel({ kind: "adjustment", cardId: null })).toBe("Ajuste");
    expect(transactionAmountPrefix("income")).toBe("+");
    expect(transactionAmountPrefix("expense")).toBe("−");
    expect(transactionAmountPrefix("transfer")).toBe("↔");
    expect(transactionAmountPrefix("adjustment")).toBe("±");
  });

  it("keeps statement pagination metadata and loads a second page over fifty items", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const cardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
    const statementId = "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211";
    for (let index = 0; index < 51; index += 1) {
      await adapter.createTransaction(workspaceId, {
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
        cardId,
      });
    }

    const first = await adapter.listStatementItems(workspaceId, statementId, { limit: 50 });
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("fixture:50");

    const second = await adapter.listStatementItems(workspaceId, statementId, {
      limit: 50,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("maps the HTTP statement page without dropping its cursor", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(input).toBe(
        "/v1/workspaces/workspace/statements/statement/items?cursor=cursor-1&limit=2",
      );
      return Response.json({
        items: [],
        page: { nextCursor: "cursor-2", hasMore: true },
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });

    await expect(
      adapter.listStatementItems("workspace", "statement", { cursor: "cursor-1", limit: 2 }),
    ).resolves.toEqual({ items: [], nextCursor: "cursor-2", hasMore: true });
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

  it("does not accept a stale timeline response after a newer request starts", async () => {
    const guard = createRequestGuard();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const firstRequest = guard.begin();
    const firstAccepted = firstResponse.then(() => guard.isCurrent(firstRequest));
    const secondRequest = guard.begin();
    const secondAccepted = secondResponse.then(() => guard.isCurrent(secondRequest));

    resolveFirst();
    await expect(firstAccepted).resolves.toBe(false);
    resolveSecond();
    await expect(secondAccepted).resolves.toBe(true);
  });

  it("rejects a deferred create result after the workspace changes", async () => {
    const guard = createWorkspaceGenerationGuard("workspace-a");
    let resolveCreate!: () => void;
    const create = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const request = guard.begin("workspace-a");

    guard.switchWorkspace("workspace-b");
    resolveCreate();

    await expect(create.then(() => guard.isCurrent(request))).resolves.toBe(false);
  });

  it("does not give canceled composition items a misleading financial sign", () => {
    expect(statementItemAmountPrefix({ type: "purchase", state: "canceled" })).toBe("Cancelada · ");
    expect(statementItemAmountPrefix({ type: "payment", state: "canceled" })).toBe("Cancelada · ");
    expect(statementItemAmountPrefix({ type: "purchase", state: "posted" })).toBe("+");
    expect(statementItemAmountPrefix({ type: "payment", state: "posted" })).toBe("−");
  });
});
