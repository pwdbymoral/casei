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

const productId = "0190f3c8-2a10-7abc-8def-1234567890ac";
const materializedItemId = "0190f3c8-2a10-7abc-8def-1234567890ad";

function shoppingScenarioPool() {
  const statements: string[] = [];
  let productQuantity = 0n;
  let productVersion = 0;
  let item: Record<string, unknown> | null = null;
  let purchasedAt: Date | null = null;
  let movementAt: Date | null = null;
  let timestampIndex = 0;

  const productRow = () => ({
    id: productId,
    workspace_id: scope.workspaceId,
    name: "Arroz",
    unit: "unit",
    unit_label: null,
    quantity_milli: productQuantity.toString(),
    minimum_milli: "10",
    marked_missing: false,
    shopping_auto: true,
    category: null,
    location: null,
    note: null,
    archived: false,
    version: productVersion,
  });

  const derivedItem = () => ({
    id: productId,
    workspace_id: scope.workspaceId,
    product_id: productId,
    name: "Arroz",
    source: "automatic",
    quantity_milli: null,
    effective_quantity_milli: "10",
    unit: "unit",
    unit_label: null,
    note: null,
    purchased: false,
    purchased_at: null,
    last_changed_by: scope.actorId,
    version: productVersion,
  });

  const nextTimestamp = () => {
    timestampIndex += 1;
    return new Date(`2025-01-01T00:00:00.00${timestampIndex}Z`);
  };

  const client = {
    async query<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM membership")) {
        return { rows: [{ role: "member", status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM workspace")) {
        return { rows: [{ status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "idempotency_key"')) {
        return { rows: [{ id: "idempotency-1" }] as T[], rowCount: 1 };
      }
      if (
        sql.includes('DELETE FROM "idempotency_key"') ||
        sql.includes('UPDATE "idempotency_key"')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM shopping_item i") && sql.includes("FOR UPDATE")) {
        return { rows: item ? [item as T] : [], rowCount: item ? 1 : 0 };
      }
      if (sql.includes("FROM stock_product") && sql.includes("FOR UPDATE")) {
        return { rows: [productRow() as T], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO shopping_item_event")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO shopping_item") && sql.includes("SELECT p.workspace_id")) {
        const shouldReappear =
          productQuantity <= 10n &&
          item?.purchased === true &&
          purchasedAt !== null &&
          movementAt !== null &&
          movementAt >= purchasedAt;
        if (!shouldReappear) return { rows: [], rowCount: 0 };
        item = {
          ...derivedItem(),
          id: materializedItemId,
        };
        return { rows: [{ id: materializedItemId } as T], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO shopping_item")) {
        item = {
          ...derivedItem(),
          id: materializedItemId,
          version: productVersion,
        };
        return { rows: [item as T], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO stock_movement")) {
        movementAt = nextTimestamp();
        const valueOffset = sql.includes("Compra da lista") ? 2 : 3;
        return {
          rows: [
            {
              id: "0190f3c8-2a10-7abc-8def-1234567890ae",
              workspace_id: scope.workspaceId,
              product_id: productId,
              kind: "entry",
              quantity_milli: values[valueOffset] ?? "1",
              before_milli: values[valueOffset + 1] ?? "0",
              after_milli: values[valueOffset + 2] ?? "1",
              reason: null,
              author_id: scope.actorId,
              occurred_at: movementAt,
            } as T,
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE stock_product")) {
        productQuantity = BigInt(values[2] as string | bigint);
        productVersion += 1;
        return { rows: [productRow() as T], rowCount: 1 };
      }
      if (sql.includes("UPDATE shopping_item")) {
        purchasedAt = movementAt ?? nextTimestamp();
        item = {
          ...(item ?? derivedItem()),
          purchased: true,
          purchased_at: purchasedAt,
          version: Number(item?.version ?? 0) + 1,
        };
        return { rows: [item as T], rowCount: 1 };
      }
      if (sql.includes("FROM shopping_item i") && sql.includes("UNION ALL")) {
        if (item && item.purchased === false) return { rows: [item as T], rowCount: 1 };
        if (item?.purchased === true && (!movementAt || !purchasedAt || movementAt < purchasedAt)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [derivedItem() as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
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

  it("derives, purchases, suppresses, and releases an automatic item across reads and movement", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const beforeRead = harness.statements.length;
    const first = await service.listShoppingItems(scope);
    const readStatements = harness.statements.slice(beforeRead);
    expect(readStatements.some((sql) => /INSERT INTO shopping_item/i.test(sql))).toBe(false);
    expect(readStatements.some((sql) => /shopping_item_event/i.test(sql))).toBe(false);
    expect(first).toHaveLength(1);
    const firstItem = first[0];
    expect(firstItem).toMatchObject({ id: productId, productId, purchased: false });
    if (!firstItem) throw new Error("expected a derived shopping item");

    await service.purchaseShoppingItem(
      scope,
      firstItem.id,
      { addToStock: false },
      "shopping-behavior-false-001",
      firstItem.version,
    );
    await expect(service.listShoppingItems(scope)).resolves.toEqual([]);

    await service.createMovement(
      scope,
      productId,
      { kind: "entry", quantity: "1" },
      "shopping-behavior-movement-001",
      0,
    );
    const afterMovement = await service.listShoppingItems(scope);
    expect(afterMovement).toHaveLength(1);
    expect(afterMovement[0]).toMatchObject({ productId, purchased: false });
  });

  it("reprocesses automatic sync after an in-stock purchase that remains low", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const item = (await service.listShoppingItems(scope))[0];
    if (!item) throw new Error("expected a derived shopping item");
    await service.purchaseShoppingItem(
      scope,
      item.id,
      { addToStock: true, quantity: "1" },
      "shopping-behavior-true-001",
      item.version,
    );

    const remaining = await service.listShoppingItems(scope);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ productId, purchased: false });
  });
});
