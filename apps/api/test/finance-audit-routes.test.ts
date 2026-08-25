import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { configureFinanceRoutes } from "../src/finance-routes.js";
import type { FinanceService } from "../src/finance-service.js";
import { createActorMiddleware, createWorkspaceScopeMiddleware } from "../src/http/middleware.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const transactionId = "0190f3c8-2a10-7abc-8def-1234567890ac";
const auditId = "0190f3c8-2a10-7abc-8def-1234567890ad";

function appFor(service: FinanceService) {
  const actor = createActorMiddleware(async () => ({ userId: "user-1" }));
  const scope = createWorkspaceScopeMiddleware(
    async ({ actor: currentActor, workspaceId: id }) => ({
      actor: currentActor,
      workspaceId: id,
      role: "viewer" as const,
    }),
  );
  return createApp((v1) =>
    configureFinanceRoutes(v1, {
      service,
      scopeMiddleware: async (context, next) => {
        await actor(context, async () => {
          await scope(context, next);
        });
      },
    }),
  );
}

describe("finance audit routes", () => {
  it("authenticates and returns list/detail envelopes", async () => {
    const service = {
      listTransactionAudit: async () => ({
        items: [
          {
            id: auditId,
            transactionId,
            before: { kind: "adjustment", version: 0, walletVersion: 3 },
            after: { kind: "adjustment", version: 0, walletVersion: 4 },
          },
        ],
        nextCursor: "signed-cursor",
        hasMore: true,
      }),
      getTransactionAudit: async () => ({
        id: auditId,
        transactionId,
        before: { kind: "adjustment", version: 0, walletVersion: 3 },
        after: { kind: "adjustment", version: 0, walletVersion: 4 },
        consequences: { ledgerEvents: [] },
      }),
    } as unknown as FinanceService;
    const app = appFor(service);

    const listResponse = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions/${transactionId}/audit?limit=10`,
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      items: [
        {
          id: auditId,
          transactionId,
          before: { kind: "adjustment", version: 0, walletVersion: 3 },
          after: { kind: "adjustment", version: 0, walletVersion: 4 },
        },
      ],
      page: { nextCursor: "signed-cursor", hasMore: true },
    });

    const detailResponse = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions/${transactionId}/audit/${auditId}`,
    );
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      id: auditId,
      transactionId,
      before: { kind: "adjustment", version: 0, walletVersion: 3 },
      after: { kind: "adjustment", version: 0, walletVersion: 4 },
      consequences: { ledgerEvents: [] },
    });
  });
});
