import { describe, expect, it } from "vitest";
import { StockPermissionError, StockService } from "../src/stock-service.js";

function poolFor(options: {
  role: "owner" | "member" | "viewer";
  status?: "active" | "revoked";
  rows?: unknown[];
}) {
  const statements: string[] = [];
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM membership")) {
        return {
          rows: [
            {
              role: options.role,
              status: options.status ?? "active",
              workspace_status: "active",
            },
          ] as T[],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM workspace")) {
        return { rows: [{ status: "active" }] as T[], rowCount: 1 };
      }
      return { rows: (options.rows ?? []) as T[], rowCount: options.rows?.length ?? 0 };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    },
    statements,
  };
}

const scope = {
  workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
  actorId: "user-1",
  correlationId: "correlation-1",
  role: "member" as const,
};

describe("StockService membership revalidation", () => {
  it("locks and checks the current membership even for a read unit of work", async () => {
    const harness = poolFor({ role: "viewer" });
    const service = new StockService(harness.pool as never);

    await expect(service.listProducts(scope)).resolves.toEqual([]);
    const lockQueries = harness.statements.filter((sql) => sql.includes("FOR UPDATE"));
    expect(lockQueries[0]).toMatch(/FROM membership/);
    expect(lockQueries[1]).toMatch(/FROM workspace/);
  });

  it("does not trust a stale writable role from the request scope", async () => {
    const harness = poolFor({ role: "viewer" });
    const service = new StockService(harness.pool as never);

    await expect(
      service.createProduct(scope, { name: "Arroz" }, "stock-service-create-001"),
    ).rejects.toBeInstanceOf(StockPermissionError);
    expect(harness.statements.some((sql) => sql.includes("INSERT INTO stock_product"))).toBe(false);
  });
});
