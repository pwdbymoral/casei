import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAdapterError, authenticatedAdminAdapter } from "./admin";

describe("admin API adapter", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "http://localhost:3001"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("searches through the administrative boundary with credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], page: { nextCursor: null, hasMore: false } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedAdminAdapter.searchAccounts("ada@example.com", 25);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/v1/admin/accounts?query=ada%40example.com&limit=25",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends reason and idempotency key for suspension", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "suspended" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedAdminAdapter.suspend("target-user", "security review");
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as unknown as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^admin-suspend-/);
    expect(init.body).toBe(JSON.stringify({ reason: "security review" }));
  });

  it("preserves the command key and server-issued step-up token on retry", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "active" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedAdminAdapter.reactivate(
      "target-user",
      "reviewed",
      "admin-reactivate-fixed-key",
      "step-up-token",
    );
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as unknown as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("admin-reactivate-fixed-key");
    expect(headers.get("X-Admin-Step-Up")).toBe("step-up-token");
  });

  it("exposes the server correlation ID from successful commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "active" }), {
            status: 200,
            headers: { "X-Correlation-ID": "01J00000000000000000000000" },
          }),
      ),
    );
    const result = await authenticatedAdminAdapter.reactivate(
      "target-user",
      "reviewed",
      "admin-reactivate-correlation",
      "step-up-token",
    );
    expect(result.correlationId).toBe("01J00000000000000000000000");
    expect(result.data).toEqual({ status: "active" });
  });

  it("maps permission and offline failures without exposing response internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "permission_denied", message: "Negado" } }),
            {
              status: 403,
              headers: { "X-Correlation-ID": "01J00000000000000000000001" },
            },
          ),
      ),
    );
    await expect(authenticatedAdminAdapter.searchAccounts("ada")).rejects.toMatchObject(
      new AdminAdapterError(403, "permission_denied", "Negado", "01J00000000000000000000001"),
    );
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    await expect(authenticatedAdminAdapter.searchAccounts("ada")).rejects.toMatchObject({
      code: "offline",
    });
  });

  it("keeps operational filters in the jobs and audit requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            page: { nextCursor: null, hasMore: false },
            health: { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0, cancelled: 0 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    await authenticatedAdminAdapter.searchJobs({ type: "data.import", state: "dead", limit: 25 });
    expect(calls[0]?.[0]).toBe(
      "http://localhost:3001/v1/admin/jobs?type=data.import&state=dead&limit=25",
    );
    await authenticatedAdminAdapter.searchAudit({ actorId: "admin", action: "job:retry" });
    expect(calls[1]?.[0]).toBe(
      "http://localhost:3001/v1/admin/audit?actorId=admin&action=job%3Aretry",
    );
  });

  it("sends reason, idempotency and step-up for job retry", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ state: "pending" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedAdminAdapter.retryJob("job-1", "reprocessar", "retry-fixed-key", "step-up");
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const init = (calls[0]?.[1] ?? {}) as unknown as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("retry-fixed-key");
    expect(headers.get("X-Admin-Step-Up")).toBe("step-up");
    expect(init.body).toBe(JSON.stringify({ reason: "reprocessar" }));
  });

  it.each([
    ["totp", "123456"],
    ["backup_code", "RECOVERY-123"],
  ] as const)("submits %s as the selected step-up method", async (method, code) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "step-up", expiresInSeconds: 300 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedAdminAdapter.completeStepUp(method, code);
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const init = (calls[0]?.[1] ?? {}) as unknown as RequestInit;
    expect(init.body).toBe(JSON.stringify({ method, code }));
  });
});
