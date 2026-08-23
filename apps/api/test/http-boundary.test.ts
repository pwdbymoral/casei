import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../src/app.js";
import {
  assertIfMatch,
  assertWorkspaceIdMatch,
  createActorMiddleware,
  createWorkspaceScopeMiddleware,
  decodeCursor,
  encodeCursor,
  etagForVersion,
  InvalidCursorError,
  parseJsonBody,
  parseListQuery,
  requireIfMatch,
  setVersionHeaders,
} from "../src/http/index.js";

describe("HTTP boundary transversal", () => {
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

    const response = await app.request(
      "http://localhost/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/payload",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      actor: { userId: "auth-user-1" },
      scope: {
        actor: { userId: "auth-user-1" },
        workspaceId: "550e8400-e29b-41d4-a716-446655440000",
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
      "http://localhost/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/payload",
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
      "http://localhost/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/payload",
    );
    expect(noScope.status).toBe(404);
    await expect(noScope.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejeita workspaceId no body quando diverge da rota", async () => {
    const app = createApp((v1) => {
      v1.post("/workspaces/:workspaceId/payload", async (context) => {
        const body = await parseJsonBody(context, z.object({ workspaceId: z.string().optional() }));
        assertWorkspaceIdMatch(context, body);
        return context.json({ ok: true });
      });
    });

    const response = await app.request(
      "http://localhost/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/payload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "550e8400-e29b-41d4-a716-446655440001" }),
      },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed", fieldErrors: { workspaceId: expect.any(Array) } },
    });
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
