import { describe, expect, it } from "vitest";
import { PostgresAdminAccountStore } from "../src/admin-store.js";

describe("ADMIN PostgreSQL adapter", () => {
  it("resolves platform role and suspension from the server-side table", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("SELECT role, status"))
          return { rows: [{ role: "platform_admin", status: "active" }], rowCount: 1 };
        return { rows: [{ role: "platform_admin", status: "active" }], rowCount: 1 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client };
    const store = new PostgresAdminAccountStore(pool as never, "casei_app");
    await expect(store.resolvePlatformActor("user-1")).resolves.toEqual({
      role: "platform_admin",
      suspended: false,
    });
    expect(queries.some((query) => query.includes("platform_account"))).toBe(true);
    expect(queries).toContain('SET LOCAL ROLE "casei_app"');
    expect(queries.some((query) => query.includes("set_config('app.actor_id'"))).toBe(true);
  });

  it("searches only minimum account metadata and does not query domestic content", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes('FROM "user"'))
          return {
            rows: [
              {
                user_id: "target-user",
                name: "Pessoa",
                email: "ada@example.com",
                role: null,
                status: "active",
                created_at: new Date("2026-08-25T12:00:00.000Z"),
                last_activity_at: null,
                workspace_count: "2",
                active_session_count: "1",
              },
            ],
            rowCount: 1,
          };
        return {
          rows: [],
          rowCount: 1,
        };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client };
    const store = new PostgresAdminAccountStore(pool as never, "casei_app");
    await expect(
      store.withActor("admin-user", () =>
        store.searchAccounts({ query: "ada@example.com", limit: 50 }),
      ),
    ).resolves.toEqual({
      items: [
        {
          userId: "target-user",
          displayName: "Pessoa",
          email: "ada@example.com",
          role: null,
          status: "active",
          createdAt: "2026-08-25T12:00:00.000Z",
          lastActivityAt: null,
          workspaceCount: 2,
          activeSessionCount: 1,
        },
      ],
      page: { nextCursor: null, hasMore: false },
    });
    const searchQuery = queries.find((query) => query.includes('FROM "user"'));
    expect(searchQuery).toContain("platform_account");
    expect(searchQuery).not.toMatch(/finance_transaction|ledger_entry|stock_product|amount_minor/i);
  });

  it("consumes a server-issued step-up proof only for a new idempotent command", async () => {
    const queries: string[] = [];
    let commandRuns = 0;
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(text);
        if (text.includes("INSERT INTO idempotency_key"))
          return { rows: [{ id: "key-1" }], rowCount: 1 };
        if (text.includes("UPDATE admin_step_up_challenge"))
          return { rows: [{ id: "proof-1" }], rowCount: 1 };
        if (text.includes("UPDATE idempotency_key")) return { rows: [], rowCount: 1 };
        void values;
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const store = new PostgresAdminAccountStore({ connect: async () => client } as never);
    await expect(
      store.executeIdempotent(
        "admin-user:platform:account:active:target-user",
        "fixed-key-00000001",
        { action: "account:active", targetId: "target-user" },
        async () => {
          commandRuns += 1;
          return { ok: true };
        },
        "admin-user",
        "step-up-proof",
      ),
    ).resolves.toEqual({ replayed: false, result: { ok: true } });
    expect(commandRuns).toBe(1);
    expect(queries.some((query) => query.includes("UPDATE admin_step_up_challenge"))).toBe(true);
  });
});
