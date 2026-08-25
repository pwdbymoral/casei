import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canWriteFinance,
  civilDateInTimeZone,
  clearTransactionQueryParams,
  commitmentBucket,
  commitmentRemainingMinor,
  createFixtureFinanceAdapter,
  createHttpFinanceAdapter,
  createQuickCaptureTransactionInput,
  createRequestGuard,
  createWorkspaceGenerationGuard,
  type FinanceAdapter,
  FinanceAdapterError,
  financeAdapterForEnvironment,
  hasTransactionQueryFilters,
  listAllTransactions,
  mergeTransactionPage,
  previewInstallmentMinor,
  shouldRetryIdempotentCommand,
  statementItemAmountPrefix,
  type Transaction,
  type TransactionQuery,
  transactionAmountPrefix,
  transactionCardIdForKind,
  transactionKindLabel,
  transactionQueryFromSearchParams,
  unauthenticatedFinanceAdapter,
  walletDeltaMinor,
  walletTotalMinor,
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

  it("formats defaults in the workspace timezone instead of the browser timezone", () => {
    const nearMidnightUtc = new Date("2026-08-25T02:30:00.000Z");
    expect(civilDateInTimeZone(nearMidnightUtc, "America/Fortaleza")).toBe("2026-08-24");
    expect(civilDateInTimeZone(nearMidnightUtc, "Asia/Tokyo")).toBe("2026-08-25");
  });

  it("loads an unfiltered wallet/commitment read model through every cursor page", async () => {
    const pages = [
      {
        items: [
          {
            id: "transaction-1",
            workspaceId: "workspace",
            kind: "income" as const,
            state: "posted" as const,
            amount: { currency: "BRL", minor: "100" },
            settledAmount: { currency: "BRL", minor: "100" },
            occurredOn: "2026-08-24",
            dueOn: null,
            postedOn: "2026-08-24T12:00:00.000Z",
            description: "Receita",
            categoryId: null,
            cardId: null,
            statementId: null,
            version: 0,
          },
        ],
        nextCursor: "cursor-1",
        hasMore: true,
      },
      {
        items: [
          {
            id: "transaction-2",
            workspaceId: "workspace",
            kind: "transfer" as const,
            state: "posted" as const,
            amount: { currency: "BRL", minor: "50" },
            settledAmount: { currency: "BRL", minor: "50" },
            occurredOn: "2026-08-23",
            dueOn: null,
            postedOn: "2026-08-23T12:00:00.000Z",
            description: "Pagamento de fatura",
            categoryId: null,
            cardId: null,
            statementId: "statement-1",
            version: 0,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    ];
    const calls: Array<Record<string, unknown> | undefined> = [];
    const adapter = {
      listTransactions: vi.fn(async (_workspaceId: string, query?: TransactionQuery) => {
        calls.push(query);
        return pages[calls.length - 1] ?? pages.at(-1);
      }),
    } as unknown as FinanceAdapter;
    await expect(listAllTransactions(adapter, "workspace")).resolves.toHaveLength(2);
    expect(calls).toEqual([
      { cursor: undefined, limit: 100 },
      { cursor: "cursor-1", limit: 100 },
    ]);
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

  it("uses If-Match and explicit confirmation for category maintenance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/categories/category-1")) {
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).get("If-Match")).toBe('"v3"');
        return Response.json({ id: "category-1", version: 4, archived: false });
      }
      expect(String(input)).toContain("/categories/category-1/archive");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v4"');
      expect(JSON.parse(String(init?.body))).toEqual({ confirm: true });
      return Response.json({ id: "category-1", version: 5, archived: true });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const category = {
      id: "category-1",
      workspaceId: "workspace",
      name: "Mercado",
      kind: "expense" as const,
      archived: false,
      version: 3,
    };
    const updated = await adapter.updateCategory("workspace", category, { name: "Feira" });
    expect(updated.version).toBe(4);
    await expect(
      adapter.archiveCategory("workspace", { ...category, version: 4 }),
    ).resolves.toMatchObject({
      archived: true,
      version: 5,
    });
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

  it("updates card configuration with an If-Match precondition", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace/cards/card-1");
      expect(init?.method).toBe("PATCH");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v3"');
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^web-/);
      expect(JSON.parse(String(init?.body))).toEqual({ closingDay: 12 });
      return Response.json({
        id: "card-1",
        workspaceId: "workspace",
        name: "Principal",
        closingDay: 12,
        dueDay: 17,
        holder: null,
        lastFour: null,
        limit: null,
        archived: false,
        version: 4,
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const card = {
      id: "card-1",
      workspaceId: "workspace",
      name: "Principal",
      closingDay: 10,
      dueDay: 17,
      holder: null,
      lastFour: null,
      limit: null,
      archived: false,
      version: 3,
    } satisfies import("./finance").CreditCard;

    await expect(adapter.updateCard("workspace", card, { closingDay: 12 })).resolves.toMatchObject({
      closingDay: 12,
      version: 4,
    });
  });

  it("archives cards through the versioned command endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace/cards/card-1/archive");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v4"');
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^web-/);
      return Response.json({ id: "card-1", archived: true, version: 5 });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    await expect(
      adapter.archiveCard("workspace", {
        id: "card-1",
        workspaceId: "workspace",
        name: "Principal",
        closingDay: 10,
        dueDay: 17,
        holder: null,
        lastFour: null,
        limit: null,
        archived: false,
        version: 4,
      }),
    ).resolves.toMatchObject({ archived: true, version: 5 });
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

  it("preserves omitted card fields and enforces fixture archive conflicts", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const [card] = await adapter.listCards(workspaceId);
    if (!card) throw new Error("fixture card missing");

    await expect(adapter.updateCard(workspaceId, card, { closingDay: 12 })).resolves.toMatchObject({
      id: card.id,
      name: card.name,
      dueDay: card.dueDay,
      closingDay: 12,
      holder: card.holder,
      version: card.version + 1,
    });
    await expect(adapter.updateCard(workspaceId, card, { name: "stale" })).rejects.toMatchObject({
      status: 412,
      currentVersion: card.version + 1,
    });
    const updated = (await adapter.listCards(workspaceId)).find((value) => value.id === card.id);
    if (!updated) throw new Error("updated fixture card missing");
    await expect(adapter.archiveCard(workspaceId, updated)).rejects.toMatchObject({ status: 409 });

    const cleanWorkspace = "workspace-without-statement";
    const cleanCard = await adapter.createCard(cleanWorkspace, {
      name: "Reserva",
      closingDay: 5,
      dueDay: 12,
    });
    await expect(adapter.archiveCard(cleanWorkspace, cleanCard)).resolves.toMatchObject({
      archived: true,
      version: 1,
    });
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

  it("drops an old category mutation after changing workspace", async () => {
    const guard = createWorkspaceGenerationGuard("workspace-a");
    const request = guard.begin("workspace-a");
    guard.switchWorkspace("workspace-b");
    const categories: string[] = [];
    const oldResponse = Promise.resolve("category-from-a");
    const value = await oldResponse;
    if (guard.isCurrent(request)) categories.push(value);
    expect(categories).toEqual([]);
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
      categoryId: null,
    });
    expect(transactionCardIdForKind("income", "card-1")).toBeNull();
    expect(transactionCardIdForKind("expense", "card-1")).toBe("card-1");
    expect(
      createQuickCaptureTransactionInput({
        kind: "expense",
        amountMinor: "500",
        currency: "USD",
        planned: false,
        description: "Feira",
        cardId: "",
        categoryId: "category-1",
      }).categoryId,
    ).toBe("category-1");
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

  it("classifies only open commitments and distributes preview cents exactly", () => {
    expect(commitmentBucket({ state: "planned", dueOn: "2026-08-23" }, "2026-08-24")).toBe(
      "overdue",
    );
    expect(
      commitmentBucket({ state: "partially_settled", dueOn: "2026-08-24" }, "2026-08-24"),
    ).toBe("upcoming");
    expect(commitmentBucket({ state: "posted", dueOn: "2026-08-24" }, "2026-08-24")).toBe(null);
    expect(
      commitmentRemainingMinor({
        amount: { currency: "BRL", minor: "1001" },
        settledAmount: { currency: "BRL", minor: "250" },
      }),
    ).toBe("751");
    expect(previewInstallmentMinor("1001", 3)).toEqual(["334", "334", "333"]);
    expect(previewInstallmentMinor("1000", 1)).toEqual([]);
  });

  it("derives wallet deltas from settled amounts, including partials and invoice transfers", () => {
    const base = {
      currency: "BRL",
      amount: { currency: "BRL", minor: "1000" },
      occurredOn: "2026-08-24",
      dueOn: null,
      postedOn: "2026-08-24T12:00:00.000Z",
      description: "",
      categoryId: null,
      version: 1,
    } as const;
    expect(
      walletDeltaMinor({
        ...base,
        kind: "expense",
        state: "partially_settled",
        settledAmount: { currency: "BRL", minor: "250" },
        cardId: null,
        statementId: null,
      }),
    ).toBe("-250");
    expect(
      walletDeltaMinor({
        ...base,
        kind: "transfer",
        state: "posted",
        settledAmount: { currency: "BRL", minor: "400" },
        cardId: null,
        statementId: "statement-1",
      }),
    ).toBe("-400");
    expect(
      walletDeltaMinor({
        ...base,
        kind: "expense",
        state: "posted",
        settledAmount: { currency: "BRL", minor: "900" },
        cardId: "card-1",
        statementId: null,
      }),
    ).toBe("0");
    expect(
      walletDeltaMinor({
        ...base,
        kind: "expense",
        state: "planned",
        settledAmount: { currency: "BRL", minor: "0" },
        cardId: null,
        statementId: null,
      }),
    ).toBe("0");
  });

  it("sums the wallet from settled deltas without double-counting refreshed snapshots", () => {
    const transaction = {
      id: "expense-1",
      kind: "expense" as const,
      state: "partially_settled" as const,
      cardId: null,
      statementId: null,
      settledAmount: { currency: "BRL", minor: "250" },
    };
    expect(
      walletTotalMinor([
        {
          id: "income-1",
          kind: "income",
          state: "posted",
          cardId: null,
          statementId: null,
          settledAmount: { currency: "BRL", minor: "1000" },
        },
        transaction,
        {
          id: "invoice-payment-1",
          kind: "transfer",
          state: "posted",
          cardId: null,
          statementId: "statement-1",
          settledAmount: { currency: "BRL", minor: "400" },
        },
        // A page refresh may append the same transaction with its latest
        // settled amount; Map semantics keep only that snapshot.
        { ...transaction, settledAmount: { currency: "BRL", minor: "500" } },
        {
          id: "card-purchase-1",
          kind: "expense",
          state: "posted",
          cardId: "card-1",
          statementId: "statement-1",
          settledAmount: { currency: "BRL", minor: "900" },
        },
      ]),
    ).toBe("100");
  });

  it("posts a commitment with the current version and effective settlement", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace/transactions/transaction-1/post");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("If-Match")).toBe('"v2"');
      expect(headers.get("Idempotency-Key")).toBe("settle-command-001");
      expect(JSON.parse(String(init?.body))).toEqual({
        amount: { currency: "BRL", minor: "2500" },
        occurredOn: "2026-08-24",
      });
      return Response.json({ id: "transaction-1", state: "partially_settled", version: 3 });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const transaction = {
      id: "transaction-1",
      workspaceId: "workspace",
      kind: "expense" as const,
      state: "planned" as const,
      amount: { currency: "BRL", minor: "5000" },
      settledAmount: { currency: "BRL", minor: "0" },
      occurredOn: "2026-08-24",
      dueOn: "2026-08-24",
      postedOn: null,
      description: "Conta",
      categoryId: null,
      cardId: null,
      statementId: null,
      version: 2,
    } satisfies Transaction;

    await expect(
      adapter.postTransaction(
        "workspace",
        transaction,
        {
          amount: { currency: "BRL", minor: "2500" },
          occurredOn: "2026-08-24",
        },
        "settle-command-001",
      ),
    ).resolves.toMatchObject({ id: "transaction-1", state: "partially_settled", version: 3 });
  });

  it("settles fixture commitments partially and then totally without exceeding the plan", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "workspace-settlement";
    const created = await adapter.createTransaction(workspaceId, {
      kind: "expense",
      amount: { currency: "BRL", minor: "5000" },
      state: "planned",
      dueOn: "2026-08-24",
      description: "Conta de luz",
    });

    const partial = await adapter.postTransaction(workspaceId, created, {
      amount: { currency: "BRL", minor: "2000" },
      occurredOn: "2026-08-30",
    });
    expect(partial).toMatchObject({
      state: "partially_settled",
      version: 1,
      occurredOn: "2026-08-30",
    });
    expect(partial.settledAmount.minor).toBe("2000");

    const total = await adapter.postTransaction(workspaceId, partial);
    expect(total).toMatchObject({ state: "posted", version: 2 });
    expect(total.settledAmount.minor).toBe("5000");
    const wallet = await adapter.listTransactions(workspaceId, { limit: 100 });
    expect(walletTotalMinor(wallet.items)).toBe("-5000");
  });

  it("persists fixture invoice payments and replays them by idempotency key", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const cardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
    await adapter.createTransaction(workspaceId, {
      kind: "expense",
      amount: { currency: "BRL", minor: "3000" },
      cardId,
      description: "Compra no cartão",
    });
    const statement = (await adapter.listStatements(workspaceId))[0];
    expect(statement?.openAmount.minor).toBe("3000");
    const first = await adapter.payStatement(
      workspaceId,
      statement as NonNullable<typeof statement>,
      { currency: "BRL", minor: "1200" },
      "fixture-payment-001",
    );
    const replay = await adapter.payStatement(
      workspaceId,
      statement as NonNullable<typeof statement>,
      { currency: "BRL", minor: "1200" },
      "fixture-payment-001",
    );
    expect(replay).toEqual(first);
    const transactions = await adapter.listTransactions(workspaceId, { limit: 100 });
    const payment = transactions.items.find(
      (transaction) => transaction.id === first.transactionId,
    );
    expect(payment).toMatchObject({ kind: "transfer", statementId: statement?.id });
    expect(payment && walletDeltaMinor(payment)).toBe("-1200");
    expect(
      transactions.items.filter((transaction) => transaction.statementId === statement?.id),
    ).toHaveLength(2);
  });

  it("persists fixture recurrence and installment plans for idempotent retries", async () => {
    const adapter = createFixtureFinanceAdapter();
    const recurrenceInput = {
      kind: "expense" as const,
      amount: { currency: "BRL", minor: "1000" },
      frequency: "monthly" as const,
      interval: 1,
      startOn: "2026-08-24",
      variable: false,
    };
    const recurrence = await adapter.createRecurrence(
      "fixture-plans",
      recurrenceInput,
      "fixture-recurrence-001",
    );
    await expect(
      adapter.createRecurrence("fixture-plans", recurrenceInput, "fixture-recurrence-001"),
    ).resolves.toEqual(recurrence);
    const installmentInput = {
      total: { currency: "BRL", minor: "1001" },
      count: 3,
      firstDueOn: "2026-08-24",
    };
    const plan = await adapter.createInstallmentPlan(
      "fixture-plans",
      installmentInput,
      "fixture-installment-001",
    );
    await expect(
      adapter.createInstallmentPlan("fixture-plans", installmentInput, "fixture-installment-001"),
    ).resolves.toEqual(plan);
    expect(plan.installments.map((item) => item.amount.minor)).toEqual(["334", "334", "333"]);
    expect(plan.installments).toHaveLength(3);
  });

  it("sends the requested partial invoice payment without reclassifying it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("/v1/workspaces/workspace/statements/statement-1/payments");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        amount: { currency: "BRL", minor: "1200" },
      });
      return Response.json({
        statementId: "statement-1",
        transactionId: "payment-1",
        amount: { currency: "BRL", minor: "1200" },
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    await expect(
      adapter.payStatement(
        "workspace",
        {
          id: "statement-1",
          workspaceId: "workspace",
          cardId: "card-1",
          periodStart: "2026-08-01",
          closingOn: "2026-08-10",
          dueOn: "2026-08-17",
          state: "closed",
          total: { currency: "BRL", minor: "3000" },
          paid: { currency: "BRL", minor: "0" },
          openAmount: { currency: "BRL", minor: "3000" },
          version: 1,
        },
        { currency: "BRL", minor: "1200" },
        "statement-payment-001",
      ),
    ).resolves.toMatchObject({ amount: { minor: "1200" } });
  });

  it("reuses invoice payment keys across retryable failures", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) throw new TypeError("network interrupted");
      return Response.json({
        statementId: "statement-1",
        transactionId: "payment-1",
        amount: { currency: "BRL", minor: "1200" },
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const statement = {
      id: "statement-1",
      workspaceId: "workspace",
      cardId: "card-1",
      periodStart: "2026-08-01",
      closingOn: "2026-08-10",
      dueOn: "2026-08-17",
      state: "closed" as const,
      total: { currency: "BRL", minor: "3000" },
      paid: { currency: "BRL", minor: "0" },
      openAmount: { currency: "BRL", minor: "3000" },
      version: 1,
    };
    await expect(
      adapter.payStatement(
        "workspace",
        statement,
        { currency: "BRL", minor: "1200" },
        "statement-payment-retry",
      ),
    ).rejects.toThrow("network interrupted");
    await expect(
      adapter.payStatement(
        "workspace",
        statement,
        { currency: "BRL", minor: "1200" },
        "statement-payment-retry",
      ),
    ).resolves.toMatchObject({ transactionId: "payment-1" });
    expect(keys).toEqual(["statement-payment-retry", "statement-payment-retry"]);
  });

  it("reuses recurrence and installment keys across retryable failures", async () => {
    const keysByPath = new Map<string, string[]>();
    const attemptsByPath = new Map<string, number>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      const attempts = (attemptsByPath.get(path) ?? 0) + 1;
      attemptsByPath.set(path, attempts);
      const keys = keysByPath.get(path) ?? [];
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      keysByPath.set(path, keys);
      if (attempts === 1)
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      if (path.endsWith("/recurrences"))
        return Response.json({ id: "recurrence-1", occurrences: [] });
      return Response.json({
        id: "installment-1",
        total: { currency: "BRL", minor: "1000" },
        count: 2,
        installments: [],
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const recurrence = {
      kind: "expense" as const,
      amount: { currency: "BRL", minor: "1000" },
      frequency: "monthly" as const,
      interval: 1,
      startOn: "2026-08-24",
      variable: false,
    };
    const installment = {
      total: { currency: "BRL", minor: "1000" },
      count: 2,
      firstDueOn: "2026-08-24",
    };
    await expect(
      adapter.createRecurrence("workspace", recurrence, "recurrence-retry"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      adapter.createRecurrence("workspace", recurrence, "recurrence-retry"),
    ).resolves.toMatchObject({ id: "recurrence-1" });
    await expect(
      adapter.createInstallmentPlan("workspace", installment, "installment-retry"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      adapter.createInstallmentPlan("workspace", installment, "installment-retry"),
    ).resolves.toMatchObject({ id: "installment-1" });
    expect(keysByPath.get("/v1/workspaces/workspace/recurrences")).toEqual([
      "recurrence-retry",
      "recurrence-retry",
    ]);
    expect(keysByPath.get("/v1/workspaces/workspace/installments")).toEqual([
      "installment-retry",
      "installment-retry",
    ]);
  });
});
