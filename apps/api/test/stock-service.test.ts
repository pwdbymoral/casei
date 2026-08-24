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
    const membershipQuery = harness.statements.find((sql) => sql.includes("FROM membership"));
    expect(membershipQuery).toMatch(/FOR UPDATE/);
  });

  it("does not trust a stale writable role from the request scope", async () => {
    const harness = poolFor({ role: "viewer" });
    const service = new StockService(harness.pool as never);

    await expect(
      service.createProduct(scope, { name: "Arroz" }, "stock-service-create-001"),
    ).rejects.toBeInstanceOf(StockPermissionError);
    expect(harness.statements.some((sql) => sql.includes("INSERT INTO stock_product"))).toBe(false);
  });

  it("keeps shopping list reads side-effect free for viewers", async () => {
    const harness = poolFor({ role: "viewer" });
    const service = new StockService(harness.pool as never);

    await expect(service.listShoppingItems({ ...scope, role: "viewer" })).resolves.toEqual([]);
    expect(harness.statements.some((sql) => /INSERT INTO shopping_item/i.test(sql))).toBe(false);
    expect(harness.statements.some((sql) => /shopping_item_event/i.test(sql))).toBe(false);
  });

  it("suppresses a purchased automatic item until a later stock movement", async () => {
    const source = await import("node:fs/promises");
    const implementation = await source.readFile(
      new URL("../src/stock-service.ts", import.meta.url),
      "utf8",
    );
    expect(implementation).toContain("prior.purchased_at >= COALESCE");
    expect(implementation).toContain("max(m.occurred_at)");
  });
});
