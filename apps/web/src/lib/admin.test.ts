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

  it("maps permission and offline failures without exposing response internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "permission_denied", message: "Negado" } }),
            {
              status: 403,
            },
          ),
      ),
    );
    await expect(authenticatedAdminAdapter.searchAccounts("ada")).rejects.toEqual(
      new AdminAdapterError(403, "permission_denied", "Negado"),
    );
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    await expect(authenticatedAdminAdapter.searchAccounts("ada")).rejects.toMatchObject({
      code: "offline",
    });
  });
});
