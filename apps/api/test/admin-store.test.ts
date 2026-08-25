import { describe, expect, it } from "vitest";
import { PostgresAdminAccountStore } from "../src/admin-store.js";

describe("ADMIN PostgreSQL adapter", () => {
  it("resolves platform role and suspension from the server-side table", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [{ role: "platform_admin", status: "active" }], rowCount: 1 };
      },
    };
    const store = new PostgresAdminAccountStore(pool as never);
    await expect(store.resolvePlatformActor("user-1")).resolves.toEqual({
      role: "platform_admin",
      suspended: false,
    });
    expect(queries[0]).toContain("platform_account");
  });

  it("searches only minimum account metadata and does not query domestic content", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
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
      },
    };
    const store = new PostgresAdminAccountStore(pool as never);
    await expect(store.searchAccounts({ query: "ada@example.com", limit: 50 })).resolves.toEqual({
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
    expect(queries[0]).toContain("platform_account");
    expect(queries[0]).not.toMatch(/finance_transaction|ledger_entry|stock_product|amount_minor/i);
  });
});
