import type { Pool } from "@casei/database";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { configureFinanceRoutes } from "../src/finance-routes.js";
import type { FinanceService } from "../src/finance-service.js";
import { createActorMiddleware, createWorkspaceScopeMiddleware } from "../src/http/middleware.js";
import type { IdentityService } from "../src/identity-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
const cardId = "0190f3c8-2a10-7abc-8def-1234567890ad";
const statementId = "0190f3c8-2a10-7abc-8def-1234567890ae";
const statementItemId = "0190f3c8-2a10-7abc-8def-1234567890af";

describe("finance HTTP composition", () => {
  it("routes category edits and archive actions with preconditions and idempotency", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const category = {
      id: "0190f3c8-2a10-7abc-8def-1234567890b0",
      workspaceId,
      name: "Mercado",
      kind: "expense" as const,
      archived: false,
      version: 1,
    };
    const fakeService = {
      updateCategory: async (...args: unknown[]) => {
        calls.push({ method: "updateCategory", args });
        return { replayed: false, category };
      },
      archiveCategory: async (...args: unknown[]) => {
        calls.push({ method: "archiveCategory", args });
        return { replayed: false, category: { ...category, archived: true, version: 2 } };
      },
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" as const }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const edited = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/categories/${category.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "category-edit-route-001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({ name: "Mercado e feira", kind: "expense" }),
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.headers.get("ETag")).toBe('"v1"');

    const archived = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/categories/${category.id}/archive`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "category-archive-route-001",
          "if-match": '"v1"',
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(archived.status).toBe(200);
    expect(archived.headers.get("ETag")).toBe('"v2"');
    expect(calls[0]?.args.slice(1)).toEqual([
      category.id,
      { name: "Mercado e feira", kind: "expense" },
      "category-edit-route-001",
      0,
    ]);
    expect(calls[1]?.args.slice(1)).toEqual([category.id, "category-archive-route-001", 1]);
  });

  it("wires finance through createApp's authenticated actor and workspace scope", async () => {
    let receivedActor: unknown;
    let receivedWorkspaceId: string | undefined;
    let receivedRole: string | undefined;
    const identityService = {
      resolveScope: async (actor: unknown, id: string) => {
        receivedActor = actor;
        receivedWorkspaceId = id;
        receivedRole = "member";
        return {
          actor: actor as { userId: string },
          workspaceId: id,
          role: "member" as const,
          correlationId: "correlation-from-request",
        };
      },
    } as unknown as IdentityService;
    const financeService = {
      listCards: async (scope: { workspaceId: string; role: string }) => {
        expect(scope.workspaceId).toBe(workspaceId);
        expect(scope.role).toBe("member");
        return [];
      },
    } as unknown as FinanceService;
    const app = createApp(undefined, {
      identity: {
        pool: {} as Pool,
        service: identityService,
        actorResolver: async () => ({ userId: "auth-user-1", email: "auth@example.com" }),
      },
      finance: { pool: {} as Pool, service: financeService },
    });

    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/cards`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      page: { nextCursor: null, hasMore: false },
    });
    expect(receivedActor).toEqual({ userId: "auth-user-1", email: "auth@example.com" });
    expect(receivedWorkspaceId).toBe(workspaceId);
    expect(receivedRole).toBe("member");
  });

  it("mounts the scoped transaction command below /v1", async () => {
    const fakeService = {
      createTransaction: async () => ({
        replayed: false,
        transaction: {
          id: transactionId,
          workspaceId,
          kind: "expense",
          state: "posted",
          amount: { currency: "BRL", minor: "100" },
          settledAmount: { currency: "BRL", minor: "100" },
          occurredOn: "2026-08-23",
          dueOn: null,
          postedOn: "2026-08-23T12:00:00.000Z",
          description: "",
          categoryId: null,
          cardId: null,
          statementId: null,
          version: 0,
        },
      }),
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({
        actor,
        workspaceId: id,
        role: "member",
      }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );
    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "finance-route-test-001",
        },
        body: JSON.stringify({
          kind: "expense",
          amount: { currency: "BRL", minor: "100" },
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ id: transactionId, workspaceId });

    const missingIdempotency = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "expense", amount: { currency: "BRL", minor: "100" } }),
      },
    );
    expect(missingIdempotency.status).toBe(422);

    const missingVersion = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions/${transactionId}/post`,
      {
        method: "POST",
        headers: { "idempotency-key": "finance-route-post-001" },
      },
    );
    expect(missingVersion.status).toBe(428);
  });

  it("passes timeline filters and cursor through the scoped route", async () => {
    let receivedQuery: unknown;
    const fakeService = {
      listTransactions: async (_scope: unknown, query: unknown) => {
        receivedQuery = query;
        return {
          items: [],
          nextCursor: "next-cursor",
          hasMore: true,
        };
      },
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" as const }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions?search=mercado&from=2026-08-01&to=2026-08-31&state=posted&kind=expense&limit=25&cursor=cursor-1`,
    );

    expect(response.status).toBe(200);
    expect(receivedQuery).toEqual({
      search: "mercado",
      from: "2026-08-01",
      to: "2026-08-31",
      state: "posted",
      kind: "expense",
      limit: 25,
      cursor: "cursor-1",
    });
    await expect(response.json()).resolves.toEqual({
      items: [],
      page: { nextCursor: "next-cursor", hasMore: true },
    });
  });

  it("passes effective settlement input and If-Match to the transaction command", async () => {
    let received: { input: unknown; expectedVersion: number | undefined } | undefined;
    const fakeService = {
      postTransaction: async (
        _scope: unknown,
        _id: string,
        _key: string,
        expectedVersion: number | undefined,
        input: unknown,
      ) => {
        received = { input, expectedVersion };
        return {
          id: transactionId,
          workspaceId,
          kind: "expense",
          state: "partially_settled",
          amount: { currency: "BRL", minor: "1000" },
          settledAmount: { currency: "BRL", minor: "250" },
          occurredOn: "2028-02-29",
          dueOn: "2028-03-01",
          postedOn: "2028-02-29T12:00:00.000Z",
          description: "Conta",
          categoryId: null,
          cardId: null,
          statementId: null,
          version: 1,
        };
      },
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" as const }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions/${transactionId}/post`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "finance-partial-route-001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({
          amount: { currency: "BRL", minor: "250" },
          occurredOn: "2028-02-29",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({
      input: {
        amount: { currency: "BRL", minor: "250" },
        occurredOn: "2028-02-29",
      },
      expectedVersion: 0,
    });
    expect(response.headers.get("ETag")).toBe('"v1"');

    const noBodyResponse = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions/${transactionId}/post`,
      {
        method: "POST",
        headers: {
          "idempotency-key": "finance-partial-route-002",
          "if-match": '"v1"',
        },
      },
    );
    expect(noBodyResponse.status).toBe(200);
    expect(received?.input).toEqual({});
  });

  it("lists cards and statements and closes an open statement with a version", async () => {
    const fakeService = {
      listCards: async () => [
        {
          id: cardId,
          workspaceId,
          name: "Nubank",
          closingDay: 10,
          dueDay: 17,
          holder: null,
          lastFour: "1234",
          limit: { currency: "BRL", minor: "100000" },
          archived: false,
          version: 0,
        },
      ],
      listStatements: async () => [
        {
          id: statementId,
          workspaceId,
          cardId,
          periodStart: "2026-08-11",
          closingOn: "2026-09-10",
          dueOn: "2026-09-17",
          state: "open",
          total: { currency: "BRL", minor: "2500" },
          paid: { currency: "BRL", minor: "0" },
          openAmount: { currency: "BRL", minor: "2500" },
          version: 0,
        },
      ],
      closeStatement: async () => ({
        id: statementId,
        workspaceId,
        cardId,
        periodStart: "2026-08-11",
        closingOn: "2026-09-10",
        dueOn: "2026-09-17",
        state: "closed",
        total: { currency: "BRL", minor: "2500" },
        paid: { currency: "BRL", minor: "0" },
        openAmount: { currency: "BRL", minor: "2500" },
        version: 1,
      }),
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const cards = await app.request(`http://localhost/v1/workspaces/${workspaceId}/cards`);
    expect(cards.status).toBe(200);
    await expect(cards.json()).resolves.toEqual({
      items: [expect.objectContaining({ id: cardId, name: "Nubank" })],
      page: { nextCursor: null, hasMore: false },
    });

    const statements = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/statements?cardId=${cardId}`,
    );
    expect(statements.status).toBe(200);
    await expect(statements.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: statementId,
          openAmount: { currency: "BRL", minor: "2500" },
        }),
      ],
      page: { nextCursor: null, hasMore: false },
    });

    const closed = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/statements/${statementId}/close`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "statement-close-route-001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(closed.status).toBe(200);
    expect(closed.headers.get("etag")).toBe('"v1"');
    await expect(closed.json()).resolves.toMatchObject({ id: statementId, state: "closed" });
  });

  it("explains statement composition and reopens a closed statement explicitly", async () => {
    let receivedItemsQuery: unknown;
    const fakeService = {
      listStatementItems: async (_scope: unknown, _statementId: string, query: unknown) => {
        receivedItemsQuery = query;
        return {
          items: [
            {
              id: statementItemId,
              transactionId,
              statementId,
              type: "purchase",
              state: "posted",
              description: "Mercado",
              occurredOn: "2026-08-23",
              amount: { currency: "BRL", minor: "2500" },
            },
          ],
          nextCursor: "opaque-next-cursor",
          hasMore: true,
        };
      },
      reopenStatement: async () => ({
        id: statementId,
        workspaceId,
        cardId,
        periodStart: "2026-08-11",
        closingOn: "2026-09-10",
        dueOn: "2026-09-17",
        state: "open",
        total: { currency: "BRL", minor: "2500" },
        paid: { currency: "BRL", minor: "0" },
        openAmount: { currency: "BRL", minor: "2500" },
        version: 2,
      }),
    } as unknown as FinanceService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: fakeService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const items = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/statements/${statementId}/items?limit=1&cursor=opaque-cursor`,
    );
    expect(items.status).toBe(200);
    expect(receivedItemsQuery).toEqual({ cursor: "opaque-cursor", limit: 1 });
    await expect(items.json()).resolves.toEqual({
      items: [expect.objectContaining({ transactionId, type: "purchase" })],
      page: { nextCursor: "opaque-next-cursor", hasMore: true },
    });

    const rejected = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/statements/${statementId}/reopen`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "statement-reopen-route-001",
          "if-match": '"v1"',
        },
        body: JSON.stringify({ confirm: false }),
      },
    );
    expect(rejected.status).toBe(422);

    const reopened = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/statements/${statementId}/reopen`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "statement-reopen-route-002",
          "if-match": '"v1"',
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    expect(reopened.status).toBe(200);
    expect(reopened.headers.get("etag")).toBe('"v2"');
    await expect(reopened.json()).resolves.toMatchObject({ id: statementId, state: "open" });
  });
});
