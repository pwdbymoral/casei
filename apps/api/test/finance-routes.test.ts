import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { configureFinanceRoutes } from "../src/finance-routes.js";
import type { FinanceService } from "../src/finance-service.js";
import { createActorMiddleware, createWorkspaceScopeMiddleware } from "../src/http/middleware.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";

describe("finance HTTP composition", () => {
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
});
