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
  retainVisibleTransactionSelection,
  type Statement,
  shouldPreserveStatementAdjustmentCommandKey,
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
  it("drops selected transactions when a refreshed filter removes them", () => {
    const transactions = [
      { id: "transaction-a" } as Transaction,
      { id: "transaction-b" } as Transaction,
    ];
    expect(
      retainVisibleTransactionSelection(["transaction-a", "transaction-b"], transactions.slice(1)),
    ).toEqual(["transaction-b"]);
  });
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

  it("previews and confirms a wallet adjustment with the previewed version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/preview")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          observedBalance: { currency: "BRL", minor: "750" },
        });
        return Response.json({
          wallet: {
            workspaceId: "workspace",
            balance: { currency: "BRL", minor: "1000" },
            version: 3,
          },
          observedBalance: { currency: "BRL", minor: "750" },
          difference: { currency: "BRL", minor: "-250" },
        });
      }
      expect(input).toBe("/v1/workspaces/workspace/wallet/adjustments");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v3"');
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("wallet-command-001");
      expect(JSON.parse(String(init?.body))).toEqual({
        observedBalance: { currency: "BRL", minor: "750" },
        reason: "Dinheiro contado",
      });
      return Response.json({
        wallet: {
          workspaceId: "workspace",
          balance: { currency: "BRL", minor: "750" },
          version: 4,
        },
        observedBalance: { currency: "BRL", minor: "750" },
        difference: { currency: "BRL", minor: "-250" },
        transaction: { id: "adjustment-1", kind: "adjustment" },
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const preview = await adapter.previewWalletAdjustment("workspace", {
      currency: "BRL",
      minor: "750",
    });
    expect(preview.difference.minor).toBe("-250");
    await expect(
      adapter.adjustWallet(
        "workspace",
        preview.wallet,
        {
          observedBalance: preview.observedBalance,
          reason: "Dinheiro contado",
        },
        "wallet-command-001",
      ),
    ).resolves.toMatchObject({ wallet: { balance: { minor: "750" }, version: 4 } });
  });

  it("keeps fixture wallet adjustments isolated and idempotent", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "wallet-fixture-workspace";
    const preview = await adapter.previewWalletAdjustment(workspaceId, {
      currency: "BRL",
      minor: "-250",
    });
    expect(preview).toMatchObject({
      wallet: { balance: { minor: "0" }, version: 0 },
      difference: { minor: "-250" },
    });
    const input = {
      observedBalance: preview.observedBalance,
      reason: "Conferência inicial",
    };
    const adjusted = await adapter.adjustWallet(
      workspaceId,
      preview.wallet,
      input,
      "fixture-wallet-command",
    );
    const replay = await adapter.adjustWallet(
      workspaceId,
      preview.wallet,
      input,
      "fixture-wallet-command",
    );
    expect(replay).toEqual(adjusted);
    await expect(adapter.getWallet(workspaceId)).resolves.toEqual({
      workspaceId,
      balance: { currency: "BRL", minor: "-250" },
      version: 1,
    });
    await expect(
      adapter.adjustWallet(workspaceId, preview.wallet, input, "fixture-wallet-command-stale"),
    ).rejects.toMatchObject({ status: 412, currentVersion: 1 });
    await expect(adapter.getWallet("another-wallet-fixture-workspace")).resolves.toMatchObject({
      balance: { minor: "0" },
      version: 0,
    });
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

  it("previews and confirms a transaction reclassification with the preview hash and category version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/reclassify/preview")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          categoryId: "category-2",
          transactions: [{ id: "transaction-1", version: 3 }],
        });
        return Response.json({
          categoryId: "category-2",
          categoryVersion: 7,
          previewHash: "a".repeat(64),
          rows: [],
          canConfirm: true,
        });
      }
      expect(String(input)).toContain("/transactions/reclassify");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"v7"');
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("reclassify-1");
      expect(JSON.parse(String(init?.body))).toMatchObject({ previewHash: "a".repeat(64) });
      return Response.json({
        committed: true,
        preview: {
          categoryId: "category-2",
          categoryVersion: 7,
          previewHash: "a".repeat(64),
          rows: [],
          canConfirm: true,
        },
        transactions: [],
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const input = { categoryId: "category-2", transactions: [{ id: "transaction-1", version: 3 }] };
    const preview = await adapter.previewTransactionReclassification("workspace", input);
    await expect(
      adapter.reclassifyTransactions("workspace", input, preview, "reclassify-1"),
    ).resolves.toMatchObject({ committed: true });
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

  it("resolves a transaction deep link even when it is outside the first timeline page", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const oldest = await adapter.createTransaction(workspaceId, {
      kind: "expense",
      amount: { currency: "BRL", minor: "100" },
      description: "Lançamento antigo",
    });
    for (let index = 0; index < 50; index += 1) {
      await adapter.createTransaction(workspaceId, {
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
      });
    }

    const page = await adapter.listTransactions(workspaceId, { limit: 50 });
    expect(page.items.some((item) => item.id === oldest.id)).toBe(false);
    await expect(adapter.getTransaction(workspaceId, oldest.id)).resolves.toMatchObject({
      id: oldest.id,
      description: "Lançamento antigo",
    });
  });

  it("fetches a statement deep link directly by id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(input).toBe("/v1/workspaces/workspace/statements/statement-1");
      return Response.json({
        id: "statement-1",
        workspaceId: "workspace",
        cardId: "card-1",
        periodStart: "2026-08-11",
        closingOn: "2026-09-10",
        dueOn: "2026-09-17",
        state: "open",
        total: { currency: "BRL", minor: "1000" },
        paid: { currency: "BRL", minor: "0" },
        openAmount: { currency: "BRL", minor: "1000" },
        version: 0,
      });
    });
    const adapter = createHttpFinanceAdapter({ fetch });

    await expect(adapter.getStatement("workspace", "statement-1")).resolves.toMatchObject({
      id: "statement-1",
      openAmount: { minor: "1000" },
    });
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

  it("persists statement adjustments and partial refunds without changing the original purchase", async () => {
    const adapter = createFixtureFinanceAdapter();
    const workspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
    const cardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
    const purchase = await adapter.createTransaction(workspaceId, {
      kind: "expense",
      amount: { currency: "BRL", minor: "3000" },
      cardId,
      description: "Compra no cartão",
    });
    let statement = (await adapter.listStatements(workspaceId))[0] as Statement;
    statement = await adapter.closeStatement(workspaceId, statement);
    const adjusted = await adapter.createStatementAdjustment(
      workspaceId,
      statement,
      {
        kind: "fee",
        amount: { currency: "BRL", minor: "100" },
        description: "Tarifa",
      },
      "fixture-adjustment-001",
    );
    await expect(
      adapter.createStatementAdjustment(
        workspaceId,
        statement,
        {
          kind: "fee",
          amount: { currency: "BRL", minor: "100" },
          description: "Tarifa",
        },
        "fixture-adjustment-001",
      ),
    ).resolves.toEqual(adjusted);
    await expect(
      adapter.createStatementRefund(
        workspaceId,
        adjusted.statement,
        {
          sourceTransactionId: adjusted.transaction.id,
          amount: { currency: "BRL", minor: "10" },
        },
        "fixture-refund-from-adjustment-001",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "A compra original não pertence a este cartão.",
    });
    await expect(
      adapter.reverseTransaction(
        workspaceId,
        adjusted.transaction,
        "fixture-reverse-adjustment-001",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "Este lançamento é um ajuste da fatura; abra a fatura e registre a correção correspondente.",
    });
    const refunded = await adapter.createStatementRefund(
      workspaceId,
      adjusted.statement,
      {
        sourceTransactionId: purchase.id,
        amount: { currency: "BRL", minor: "1250" },
      },
      "fixture-refund-001",
    );
    await expect(
      adapter.createStatementRefund(
        workspaceId,
        adjusted.statement,
        {
          sourceTransactionId: purchase.id,
          amount: { currency: "BRL", minor: "1250" },
        },
        "fixture-refund-001",
      ),
    ).resolves.toEqual(refunded);
    expect(refunded.statement.total.minor).toBe("1850");
    expect(refunded.transaction.amount.minor).toBe("1250");
    expect(purchase.amount.minor).toBe("3000");
    const items = await adapter.listStatementItems(workspaceId, statement.id);
    expect(items.items.map((item) => [item.type, item.amount.minor])).toEqual([
      ["refund", "-1250"],
      ["adjustment", "100"],
      ["purchase", "3000"],
    ]);
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

  it("reuses statement correction keys across retryable failures", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) throw new TypeError("network interrupted");
      return Response.json({
        transaction: { id: "adjustment-1" },
        statement: { id: "statement-1", version: 2 },
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
    const input = {
      kind: "fee" as const,
      amount: { currency: "BRL", minor: "100" },
      description: "Tarifa",
    };
    await expect(
      adapter.createStatementAdjustment(
        "workspace",
        statement,
        input,
        "statement-correction-retry",
      ),
    ).rejects.toThrow("network interrupted");
    await expect(
      adapter.createStatementAdjustment(
        "workspace",
        statement,
        input,
        "statement-correction-retry",
      ),
    ).resolves.toMatchObject({ transaction: { id: "adjustment-1" } });
    expect(keys).toEqual(["statement-correction-retry", "statement-correction-retry"]);
  });

  it("keeps a statement correction key while cancel/close/switch controls are pending", () => {
    let commandKey: string | null = "statement-correction-pending";
    for (const interaction of ["cancel", "close", "switch-action", "switch-purchase"]) {
      if (!shouldPreserveStatementAdjustmentCommandKey(true)) commandKey = null;
      expect(commandKey, `${interaction} must preserve the pending command key`).toBe(
        "statement-correction-pending",
      );
    }
    expect(shouldPreserveStatementAdjustmentCommandKey(false)).toBe(false);
    if (!shouldPreserveStatementAdjustmentCommandKey(false)) commandKey = null;
    expect(commandKey).toBeNull();
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

  it("sends statement adjustment and refund commands with the statement version", async () => {
    const requests: Array<{ path: string; headers: Headers; body: unknown }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push({
        path: String(input),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({
        transaction: { id: "transaction-1" },
        statement: { id: "statement-1", version: 2 },
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
    await adapter.createStatementAdjustment(
      "workspace",
      statement,
      {
        kind: "fee",
        amount: { currency: "BRL", minor: "100" },
        description: "Tarifa",
      },
      "statement-adjustment-test",
    );
    await adapter.createStatementRefund(
      "workspace",
      statement,
      {
        sourceTransactionId: "purchase-1",
        amount: { currency: "BRL", minor: "100" },
      },
      "statement-refund-test",
    );
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/workspaces/workspace/statements/statement-1/adjustments",
      "/v1/workspaces/workspace/statements/statement-1/refunds",
    ]);
    expect(
      requests.map(({ headers }) => [headers.get("Idempotency-Key"), headers.get("If-Match")]),
    ).toEqual([
      ["statement-adjustment-test", '"v1"'],
      ["statement-refund-test", '"v1"'],
    ]);
    expect(statementItemAmountPrefix({ type: "refund", state: "posted" })).toBe("−");
  });

  it("sends scoped recurrence and installment edits with version guards", async () => {
    const requests: Array<{ path: string; method: string; headers: Headers; body: unknown }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).includes("recurrences")) {
        return Response.json({ recurrence: { id: "rec-1", version: 3 }, affectedOccurrences: [] });
      }
      return Response.json({ id: "plan-1", version: 4, installments: [] });
    });
    const adapter = createHttpFinanceAdapter({ fetch });
    const recurrence = {
      id: "rec-1",
      workspaceId: "workspace",
      kind: "expense" as const,
      amount: { currency: "BRL", minor: "1000" },
      frequency: "monthly" as const,
      interval: 1,
      startOn: "2026-08-01",
      endOn: null,
      maxOccurrences: null,
      variable: true,
      estimatedAmount: { currency: "BRL", minor: "1500" },
      description: "Conta",
      pausedOn: null,
      version: 2,
    };
    await adapter.updateRecurrence(
      "workspace",
      recurrence,
      { scope: "this", effectiveOn: "2026-09-01", amount: recurrence.amount },
      "rec-edit-1",
    );
    const plan = {
      id: "plan-1",
      workspaceId: "workspace",
      total: { currency: "BRL", minor: "3000" },
      count: 3,
      firstDueOn: "2026-08-01",
      version: 3,
      installments: [],
    };
    await adapter.updateInstallmentPlan("workspace", plan, { count: 4 }, "plan-edit-1");
    expect(requests.map(({ path, method }) => [path, method])).toEqual([
      ["/v1/workspaces/workspace/recurrences/rec-1", "PATCH"],
      ["/v1/workspaces/workspace/installments/plan-1", "PATCH"],
    ]);
    expect(
      requests.map(({ headers }) => [headers.get("Idempotency-Key"), headers.get("If-Match")]),
    ).toEqual([
      ["rec-edit-1", '"v2"'],
      ["plan-edit-1", '"v3"'],
    ]);
    expect(requests[0]?.body).not.toHaveProperty("estimatedAmount");
  });

  it("edits fixture recurrence and keeps installment totals distributed", async () => {
    const adapter = createFixtureFinanceAdapter();
    const recurrenceInput = {
      kind: "expense" as const,
      amount: { currency: "BRL", minor: "1000" },
      frequency: "monthly" as const,
      interval: 1,
      startOn: "2026-08-01",
      variable: false,
      description: "Aluguel",
    };
    const created = await adapter.createRecurrence("plans", recurrenceInput, "rec-create");
    const recurrence = await adapter.getRecurrence("plans", created.id);
    const edited = await adapter.updateRecurrence(
      "plans",
      recurrence,
      {
        scope: "this_and_future",
        effectiveOn: "2026-08-01",
        amount: { currency: "BRL", minor: "1200" },
      },
      "rec-edit",
    );
    expect(edited.recurrence.amount.minor).toBe("1200");
    await expect(
      adapter.updateRecurrence(
        "plans",
        edited.recurrence,
        { scope: "this", effectiveOn: "2026-08-01", amount: { currency: "BRL", minor: "900" } },
        "rec-exception",
      ),
    ).rejects.toMatchObject({ status: 422 });
    const planCreated = await adapter.createInstallmentPlan(
      "plans",
      { total: { currency: "BRL", minor: "1000" }, count: 3, firstDueOn: "2026-08-01" },
      "plan-create",
    );
    const plan = await adapter.getInstallmentPlan("plans", planCreated.id);
    const updated = await adapter.updateInstallmentPlan("plans", plan, { count: 4 }, "plan-edit");
    expect(updated.installments).toHaveLength(4);
    expect(
      updated.installments.reduce((sum, item) => sum + BigInt(item.amount.minor), BigInt(0)),
    ).toBe(BigInt(1000));
  });

  it("binds recurrence edit idempotency to the expected version", async () => {
    const adapter = createFixtureFinanceAdapter();
    const created = await adapter.createRecurrence(
      "recurrence-invariants",
      {
        kind: "expense",
        amount: { currency: "BRL", minor: "1000" },
        frequency: "monthly",
        interval: 1,
        startOn: "2026-08-01",
        variable: false,
        description: "Conta",
      },
      "recurrence-plan-create",
    );
    const recurrence = await adapter.getRecurrence("recurrence-invariants", created.id);
    const input = {
      scope: "this_and_future" as const,
      effectiveOn: "2026-08-01",
      amount: { currency: "BRL", minor: "1200" },
    };
    const updated = await adapter.updateRecurrence(
      "recurrence-invariants",
      recurrence,
      input,
      "recurrence-edit-command",
    );
    await expect(
      adapter.updateRecurrence(
        "recurrence-invariants",
        updated.recurrence,
        input,
        "recurrence-edit-command",
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("replays plan edits and never redistributes a realized installment", async () => {
    const adapter = createFixtureFinanceAdapter();
    const created = await adapter.createInstallmentPlan(
      "plan-invariants",
      { total: { currency: "BRL", minor: "1000" }, count: 3, firstDueOn: "2026-08-01" },
      "plan-create-invariants",
    );
    const plan = await adapter.getInstallmentPlan("plan-invariants", created.id);
    plan.installments[0] = { ...plan.installments[0], state: "posted" };
    const updated = await adapter.updateInstallmentPlan(
      "plan-invariants",
      plan,
      { total: { currency: "BRL", minor: "1300" }, count: 4 },
      "plan-edit-invariants",
    );
    const replay = await adapter.updateInstallmentPlan(
      "plan-invariants",
      plan,
      { total: { currency: "BRL", minor: "1300" }, count: 4 },
      "plan-edit-invariants",
    );
    expect(replay).toEqual(updated);
    expect(updated.installments[0]?.amount.minor).toBe("334");
    expect(
      updated.installments.reduce((sum, item) => sum + BigInt(item.amount.minor), BigInt(0)),
    ).toBe(BigInt(1300));
  });

  it("replays installment item commands before the stale-version check and rejects broken conservation", async () => {
    const adapter = createFixtureFinanceAdapter();
    const created = await adapter.createInstallmentPlan(
      "item-invariants",
      { total: { currency: "BRL", minor: "1000" }, count: 2, firstDueOn: "2026-08-01" },
      "item-plan-create",
    );
    const plan = await adapter.getInstallmentPlan("item-invariants", created.id);
    const item = plan.installments[0];
    const updated = await adapter.updateInstallment(
      "item-invariants",
      plan,
      item,
      { amount: { currency: "BRL", minor: "600" } },
      "item-edit",
    );
    await expect(
      adapter.updateInstallment(
        "item-invariants",
        plan,
        item,
        { amount: { currency: "BRL", minor: "600" } },
        "item-edit",
      ),
    ).resolves.toEqual(updated);
    await expect(
      adapter.updateInstallment(
        "item-invariants",
        updated,
        updated.installments[0],
        { amount: { currency: "BRL", minor: "1000" } },
        "item-invalid",
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("binds cancellation idempotency to the expected plan version", async () => {
    const adapter = createFixtureFinanceAdapter();
    const created = await adapter.createInstallmentPlan(
      "cancel-invariants",
      { total: { currency: "BRL", minor: "1000" }, count: 3, firstDueOn: "2026-08-01" },
      "cancel-plan-create",
    );
    const plan = await adapter.getInstallmentPlan("cancel-invariants", created.id);
    const canceled = await adapter.cancelFutureInstallments(
      "cancel-invariants",
      plan,
      "cancel-command",
    );
    expect(canceled.version).toBe(plan.version + 1);
    const current = await adapter.getInstallmentPlan("cancel-invariants", created.id);
    await expect(
      adapter.cancelFutureInstallments("cancel-invariants", current, "cancel-command"),
    ).rejects.toMatchObject({ status: 409 });
  });
});
