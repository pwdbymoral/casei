import { correlationIdSchema, domainIdSchema, workspaceMembershipSchema } from "@casei/contracts";
import type { Pool } from "@casei/database";
import { IdempotencyConflictError } from "@casei/database";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../src/app.js";
import type { FinanceService } from "../src/finance-service.js";
import {
  assertIfMatch,
  createActorMiddleware,
  createWorkspaceScopeMiddleware,
  decodeCursor,
  encodeCursor,
  etagForVersion,
  InvalidCursorError,
  parseJsonBody,
  parseListQuery,
  rateLimitedError,
  requireIfMatch,
  setVersionHeaders,
} from "../src/http/index.js";
import type { StockService } from "../src/stock-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const otherWorkspaceId = "0190f3c8-2a10-7abc-8def-1234567890ac";

describe("HTTP boundary transversal", () => {
  it("mantém IDs de domínio como UUIDv7 lowercase e user ID opaco", () => {
    expect(
      workspaceMembershipSchema.parse({
        userId: "better-auth-user-01",
        workspaceId,
        role: "member",
      }),
    ).toMatchObject({ userId: "better-auth-user-01", workspaceId });
    expect(domainIdSchema.safeParse(workspaceId).success).toBe(true);
    expect(domainIdSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(false);
    expect(domainIdSchema.safeParse(workspaceId.toUpperCase()).success).toBe(false);
    expect(correlationIdSchema.safeParse("81J6Q3B5M8G7T5N4R3Q2P1WXYZ").success).toBe(false);
    expect(correlationIdSchema.safeParse("01J6Q3B5M8G7T5N4R3Q2P1WXYZ").success).toBe(true);
  });

  it("gera e propaga correlation ID ULID sem vazar detalhes internos", async () => {
    const app = createApp();

    const response = await app.request("http://localhost/v1/missing");
    const correlationId = response.headers.get("x-correlation-id");

    expect(response.status).toBe(404);
    expect(correlationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Recurso não encontrado.",
        correlationId,
      },
    });

    const supplied = "01J6Q3B5M8G7T5N4R3Q2P1WXYZ";
    const withSupplied = await app.request("http://localhost/v1/missing", {
      headers: { "X-Correlation-ID": supplied },
    });
    expect(withSupplied.headers.get("x-correlation-id")).toBe(supplied);
  });

  it("preserva mapeamentos financeiros quando DATA-006 também está montado", async () => {
    const identityService = {
      resolveScope: async (_actor: unknown, workspaceId: string) => ({
        actor: { userId: "user-1" },
        workspaceId,
        role: "member" as const,
        correlationId: "correlation-composed",
      }),
    };
    const financeService = {
      createTransaction: async () => {
        throw new IdempotencyConflictError();
      },
    } as unknown as FinanceService;
    const stockService = {
      createProduct: async () => {
        throw new IdempotencyConflictError();
      },
    } as unknown as StockService;
    const app = createApp(undefined, {
      identity: {
        pool: {} as Pool,
        service: identityService as never,
        actorResolver: async () => ({ userId: "user-1" }),
      },
      finance: { pool: {} as Pool, service: financeService },
      stock: { pool: {} as Pool, service: stockService },
      dataExchange: {},
    });

    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/transactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "finance-key-123456" },
        body: JSON.stringify({
          kind: "expense",
          amount: { currency: "BRL", minor: "100" },
          description: "Teste",
        }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const stockResponse = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/stock/products`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "stock-key-123456" },
        body: JSON.stringify({ name: "Arroz" }),
      },
    );
    expect(stockResponse.status).toBe(409);
    await expect(stockResponse.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("faz parsing Zod de JSON e devolve fieldErrors no envelope", async () => {
    const app = createApp((v1) => {
      v1.post("/payload", async (context) => {
        const body = await parseJsonBody(context, z.object({ amount: z.number().positive() }));
        return context.json(body);
      });
    });

    const invalid = await app.request("http://localhost/v1/payload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 0 }),
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        fieldErrors: { amount: expect.any(Array) },
      },
    });

    const malformed = await app.request("http://localhost/v1/payload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "malformed_request" },
    });
  });

  it("constrói actor e scope no servidor, sem confiar no body", async () => {
    const app = createApp((v1) => {
      v1.post(
        "/workspaces/:workspaceId/payload",
        createActorMiddleware(async () => ({ userId: "auth-user-1" })),
        createWorkspaceScopeMiddleware(async ({ actor, workspaceId }) => ({
          actor,
          workspaceId,
          role: "member",
        })),
        (context) =>
          context.json({
            actor: context.get("actor"),
            scope: context.get("workspaceScope"),
          }),
      );
    });

    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/payload`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      actor: { userId: "auth-user-1" },
      scope: {
        actor: { userId: "auth-user-1" },
        workspaceId,
        role: "member",
      },
    });
  });

  it("nega sessão sem enumerar o motivo e espaço sem membership como 404", async () => {
    const unauthenticated = createApp((v1) => {
      v1.get(
        "/workspaces/:workspaceId/payload",
        createActorMiddleware(async () => null),
        () => new Response("unreachable"),
      );
    });
    const noSession = await unauthenticated.request(
      `http://localhost/v1/workspaces/${workspaceId}/payload`,
    );
    expect(noSession.status).toBe(401);
    await expect(noSession.json()).resolves.toMatchObject({
      error: { code: "unauthenticated" },
    });

    const noMembership = createApp((v1) => {
      v1.get(
        "/workspaces/:workspaceId/payload",
        createActorMiddleware(async () => ({ userId: "auth-user-1" })),
        createWorkspaceScopeMiddleware(async () => null),
        () => new Response("unreachable"),
      );
    });
    const noScope = await noMembership.request(
      `http://localhost/v1/workspaces/${workspaceId}/payload`,
    );
    expect(noScope.status).toBe(404);
    await expect(noScope.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejeita workspaceId no body quando diverge da rota", async () => {
    const app = createApp((v1) => {
      v1.post("/workspaces/:workspaceId/payload", async (context) => {
        await parseJsonBody(context, z.object({ value: z.string().optional() }));
        return context.json({ ok: true });
      });
    });

    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/payload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: otherWorkspaceId }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed", fieldErrors: { workspaceId: expect.any(Array) } },
    });
  });

  it("envia Retry-After configurável e default para rate limit", async () => {
    const app = createApp((v1) => {
      v1.get("/limited-default", () => {
        throw rateLimitedError();
      });
      v1.get("/limited-custom", () => {
        throw rateLimitedError(17);
      });
    });

    const defaultResponse = await app.request("http://localhost/v1/limited-default");
    expect(defaultResponse.status).toBe(429);
    expect(defaultResponse.headers.get("retry-after")).toBe("60");
    await expect(defaultResponse.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });

    const customResponse = await app.request("http://localhost/v1/limited-custom");
    expect(customResponse.status).toBe(429);
    expect(customResponse.headers.get("retry-after")).toBe("17");
  });

  it("protege cursores opacos contra adulteração e limita paginação", () => {
    const cursor = encodeCursor(
      { ordering: "created_at,id", position: ["2026-08-23T12:00:00.000Z", "x"] },
      "test-secret-that-is-long-enough",
    );
    expect(cursor).not.toContain("created_at");
    expect(decodeCursor(cursor, "test-secret-that-is-long-enough")).toEqual({
      ordering: "created_at,id",
      position: ["2026-08-23T12:00:00.000Z", "x"],
    });
    expect(() =>
      decodeCursor(`${cursor.slice(0, -1)}A`, "test-secret-that-is-long-enough"),
    ).toThrow("cursor");

    const defaultQuery = parseListQuery(new URLSearchParams());
    if (!defaultQuery.data) throw new Error("expected default pagination query");
    expect(defaultQuery.data).toEqual({
      cursor: undefined,
      limit: 50,
    });
    const maxQuery = parseListQuery(new URLSearchParams("limit=100"));
    if (!maxQuery.data) throw new Error("expected max pagination query");
    expect(maxQuery.data.limit).toBe(100);
    const invalidQuery = parseListQuery(new URLSearchParams("limit=101"));
    expect(invalidQuery.error).toBeDefined();
  });

  it("converte cursor adulterado em erro de entrada seguro", async () => {
    const app = createApp((v1) => {
      v1.get("/items", () => {
        throw new InvalidCursorError();
      });
    });
    const response = await app.request("http://localhost/v1/items");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "malformed_request" },
    });
  });

  it("aplica If-Match/ETag e diferencia ausência de conflito", async () => {
    const app = createApp((v1) => {
      v1.patch("/resource", (context) => {
        requireIfMatch(context);
        assertIfMatch(context, 3);
        setVersionHeaders(context, 4);
        return context.json({ id: "resource", version: 4 });
      });
    });

    const missing = await app.request("http://localhost/v1/resource", { method: "PATCH" });
    expect(missing.status).toBe(428);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "precondition_required" },
    });

    const malformed = await app.request("http://localhost/v1/resource", {
      method: "PATCH",
      headers: { "If-Match": "v3" },
    });
    expect(malformed.status).toBe(428);

    const conflict = await app.request("http://localhost/v1/resource", {
      method: "PATCH",
      headers: { "If-Match": etagForVersion(2) },
    });
    expect(conflict.status).toBe(412);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "version_conflict", currentVersion: 3 },
    });

    const success = await app.request("http://localhost/v1/resource", {
      method: "PATCH",
      headers: { "If-Match": etagForVersion(3) },
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("etag")).toBe('"v4"');
  });

  it("mantém health legado e acrescenta correlation ID", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "casei-api", status: "ok" });
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
