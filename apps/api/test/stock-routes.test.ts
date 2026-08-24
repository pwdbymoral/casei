import { IdempotencyConflictError, type Pool } from "@casei/database";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { IdentityService } from "../src/identity-service.js";
import { stockErrorToHttp } from "../src/stock-routes.js";
import { type StockService, StockVersionConflictError } from "../src/stock-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const productId = "0190f3c8-2a10-7abc-8def-1234567890ac";

const product = {
  id: productId,
  workspaceId,
  name: "Arroz",
  unit: "kg" as const,
  unitLabel: null,
  quantity: "2",
  minimum: "1",
  markedMissing: false,
  state: "ok" as const,
  category: null,
  location: null,
  note: null,
  archived: false,
  version: 0,
};

const shoppingItem = {
  id: "0190f3c8-2a10-7abc-8def-1234567890ad",
  workspaceId,
  productId,
  name: "Arroz",
  source: "automatic" as const,
  quantity: "1",
  unit: "kg" as const,
  unitLabel: null,
  note: null,
  purchased: false,
  purchasedAt: null,
  lastChangedBy: "user-1",
  version: 0,
};

function appFor(service: StockService) {
  const identityService = {
    resolveScope: async (actor: unknown, id: string) => ({
      actor: actor as { userId: string },
      workspaceId: id,
      role: "member" as const,
      correlationId: "correlation-from-request",
    }),
  } as unknown as IdentityService;
  return createApp(undefined, {
    identity: {
      pool: {} as Pool,
      service: identityService,
      actorResolver: async () => ({ userId: "user-1" }),
    },
    stock: { pool: {} as Pool, service },
  });
}

describe("stock HTTP boundary", () => {
  it("maps idempotency conflicts to a stable 409 API error", () => {
    const error = stockErrorToHttp(new IdempotencyConflictError());
    expect(error).toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("requires idempotency for creation and scopes list to authenticated workspace", async () => {
    const service = {
      listProducts: async (scope: { workspaceId: string; role: string }) => {
        expect(scope.workspaceId).toBe(workspaceId);
        expect(scope.role).toBe("member");
        return [product];
      },
      createProduct: async () => ({ replayed: false, product }),
    } as unknown as StockService;
    const app = appFor(service);
    const listed = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/products`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      items: [product],
      page: { nextCursor: null, hasMore: false },
    });
    const missingKey = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/products`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Arroz" }),
      },
    );
    expect(missingKey.status).toBe(422);
  });

  it("requires If-Match for quantity commands and returns current version on conflict", async () => {
    const service = {
      createMovement: async () => {
        throw new StockVersionConflictError(4);
      },
    } as unknown as StockService;
    const app = appFor(service);
    const missingVersion = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/products/${productId}/movements`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "stock-route-movement-01",
        },
        body: JSON.stringify({ kind: "entry", quantity: "1" }),
      },
    );
    expect(missingVersion.status).toBe(428);
    const conflict = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/products/${productId}/movements`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "stock-route-movement-02",
          "if-match": '"v3"',
        },
        body: JSON.stringify({ kind: "entry", quantity: "1" }),
      },
    );
    expect(conflict.status).toBe(412);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "version_conflict", currentVersion: 4 },
    });
  });

  it("lista compras e exige confirmação explícita para alterar estoque", async () => {
    let purchaseInput: unknown;
    const service = {
      listShoppingItems: async () => [shoppingItem],
      createShoppingItem: async () => ({ replayed: false, deduplicated: true, item: shoppingItem }),
      purchaseShoppingItem: async (_scope: unknown, _id: string, input: unknown) => {
        purchaseInput = input;
        return {
          replayed: false,
          item: { ...shoppingItem, purchased: true, version: 1 },
          product: null,
          movement: null,
        };
      },
    } as unknown as StockService;
    const app = appFor(service);
    const listed = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/shopping`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ items: [shoppingItem] });
    const free = await app.request(`http://localhost/v1/workspaces/${workspaceId}/stock/shopping`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "shopping-free-0001" },
      body: JSON.stringify({ name: "Saco reutilizável" }),
    });
    expect(free.status).toBe(200);
    expect(free.headers.get("X-List-Deduplicated")).toBe("true");
    const purchased = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/shopping/${shoppingItem.id}/purchased`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "shopping-purchase-0001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({ addToStock: false }),
      },
    );
    expect(purchased.status).toBe(200);
    expect(purchaseInput).toEqual({ addToStock: false });
  });
});
