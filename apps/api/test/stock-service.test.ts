import { describe, expect, it } from "vitest";
import { StockConflictError, StockPermissionError, StockService } from "../src/stock-service.js";

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

function shoppingScenarioPool(
  expense: { kind: string; state: string } = { kind: "expense", state: "posted" },
) {
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
    expense_transaction_id: null,
    last_changed_by: null,
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
      if (sql.includes("FROM finance_transaction")) {
        return { rows: [expense] as T[], rowCount: 1 };
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
      if (sql.includes("FROM shopping_item i") && sql.includes("AND i.id = $2")) {
        const requestedItemId = values[1];
        const loaded = item && requestedItemId === item.id ? item : null;
        return { rows: loaded ? [loaded as T] : [], rowCount: loaded ? 1 : 0 };
      }
      if (sql.includes("FROM stock_product") && sql.includes("FOR UPDATE")) {
        return { rows: [productRow() as T], rowCount: 1 };
      }
      if (
        sql.includes("FROM shopping_item prior") &&
        !sql.includes("UNION ALL") &&
        !sql.includes("INSERT INTO shopping_item")
      ) {
        const suppressed =
          item?.purchased === true && movementAt !== null && purchasedAt !== null
            ? purchasedAt > movementAt
            : item?.purchased === true && movementAt === null;
        return {
          rows: suppressed ? ([{ id: item?.id }] as T[]) : [],
          rowCount: suppressed ? 1 : 0,
        };
      }
      if (sql.includes("INSERT INTO shopping_item_event")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO shopping_item") && sql.includes("SELECT p.workspace_id")) {
        if (!item) {
          item = {
            ...derivedItem(),
            id: materializedItemId,
            last_changed_by: scope.actorId,
            version: sql.includes("p.version") ? productVersion : 0,
          };
          return { rows: [{ id: materializedItemId } as T], rowCount: 1 };
        }
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
          last_changed_by: scope.actorId,
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
      if (
        sql.includes("UPDATE shopping_item i") &&
        (sql.includes("SET version = p.version") || sql.includes("SET name = p.name"))
      ) {
        if (item && values[2] === productId && item.purchased === false) {
          item = { ...item, version: productVersion, last_changed_by: scope.actorId };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE shopping_item i") && sql.includes("SET product_id = p.id")) {
        return { rows: [], rowCount: 0 };
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
          expense_transaction_id: values[2] ?? null,
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

function freeCollisionPool() {
  const statements: string[] = [];
  const product = {
    id: productId,
    workspace_id: scope.workspaceId,
    name: "Arroz",
    unit: "unit",
    unit_label: null,
    quantity_milli: "0",
    minimum_milli: "10",
    marked_missing: false,
    shopping_auto: true,
    category: null,
    location: null,
    note: null,
    archived: false,
    version: 0,
  };
  let item: Record<string, unknown> = {
    id: materializedItemId,
    workspace_id: scope.workspaceId,
    product_id: null,
    name: "Arroz",
    source: "free",
    quantity_milli: "1",
    effective_quantity_milli: "1",
    unit: "unit",
    unit_label: null,
    note: "livre",
    purchased: false,
    purchased_at: null,
    last_changed_by: scope.actorId,
    version: 0,
  };

  const client = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
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
      if (sql.includes("INSERT INTO stock_product")) {
        return { rows: [product] as T[], rowCount: 1 };
      }
      if (
        sql.includes("UPDATE shopping_item i") &&
        sql.includes("FROM stock_product p") &&
        sql.includes("i.source = 'free'")
      ) {
        item = {
          ...item,
          product_id: product.id,
          source: "automatic",
          quantity_milli: null,
          effective_quantity_milli: "10",
          unit: product.unit,
          version: product.version,
        };
        return { rows: [{ id: item.id }] as T[], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO shopping_item") && sql.includes("SELECT p.workspace_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO shopping_item_event")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH visible_items")) {
        return { rows: [item] as T[], rowCount: 1 };
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

function productRenameCollisionPool(archived = false) {
  const statements: string[] = [];
  const currentProduct = {
    id: productId,
    workspace_id: scope.workspaceId,
    name: "Arroz",
    unit: "unit" as const,
    unit_label: null,
    quantity_milli: "0",
    minimum_milli: "10",
    marked_missing: false,
    shopping_auto: true,
    category: null,
    location: null,
    note: null,
    archived,
    version: 0,
  };
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM membership")) {
        return { rows: [{ role: "member", status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM workspace")) {
        return { rows: [{ status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("SELECT name FROM stock_product")) {
        return { rows: [{ name: currentProduct.name }] as T[], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "idempotency_key"')) {
        return { rows: [{ id: "idempotency-1" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM stock_product") && sql.includes("FOR UPDATE")) {
        return { rows: [currentProduct as T], rowCount: 1 };
      }
      if (sql.includes("FROM shopping_item") && sql.includes("source = 'free'")) {
        return { rows: [{ id: materializedItemId }] as T[], rowCount: 1 };
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

function productRenameSyncPool() {
  const statements: string[] = [];
  const currentProduct = {
    id: productId,
    workspace_id: scope.workspaceId,
    name: "Arroz",
    unit: "unit" as const,
    unit_label: null,
    quantity_milli: "0",
    minimum_milli: "10",
    marked_missing: false,
    shopping_auto: true,
    category: null,
    location: null,
    note: "base",
    archived: false,
    version: 0,
  };
  const updatedProduct = { ...currentProduct, name: "Arroz integral", version: 1 };
  let item = {
    id: materializedItemId,
    workspace_id: scope.workspaceId,
    product_id: productId,
    name: "Arroz",
    source: "automatic" as const,
    quantity_milli: null,
    effective_quantity_milli: "10",
    unit: "unit" as const,
    unit_label: null,
    note: null,
    purchased: false,
    purchased_at: null,
    last_changed_by: scope.actorId,
    version: 0,
  };
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM membership")) {
        return { rows: [{ role: "member", status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM workspace")) {
        return { rows: [{ status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("SELECT name FROM stock_product")) {
        return { rows: [{ name: currentProduct.name }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM stock_product") && sql.includes("FOR UPDATE")) {
        return { rows: [currentProduct as T], rowCount: 1 };
      }
      if (sql.includes("UPDATE stock_product")) {
        return { rows: [updatedProduct as T], rowCount: 1 };
      }
      if (sql.includes("UPDATE shopping_item i") && sql.includes("SET product_id = p.id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE shopping_item i") && sql.includes("SET name = p.name")) {
        item = { ...item, name: updatedProduct.name, version: updatedProduct.version };
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO shopping_item")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH visible_items")) {
        return { rows: [item as T], rowCount: 1 };
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

function partialProductUpdatePool() {
  const statements: string[] = [];
  let updateValues: unknown[] | null = null;
  const currentProduct = {
    id: productId,
    workspace_id: scope.workspaceId,
    name: "Arroz",
    unit: "package" as const,
    unit_label: "saco",
    quantity_milli: "2000",
    minimum_milli: "1000",
    marked_missing: false,
    shopping_auto: false,
    category: "Grãos",
    location: "Despensa",
    note: "Preferir integral",
    archived: false,
    version: 0,
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
      if (sql.includes("SELECT name FROM stock_product")) {
        return { rows: [{ name: currentProduct.name }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM stock_product") && sql.includes("FOR UPDATE")) {
        return { rows: [currentProduct as T], rowCount: 1 };
      }
      if (sql.includes("UPDATE stock_product")) {
        updateValues = values;
        return {
          rows: [
            {
              ...currentProduct,
              name: values[2],
              unit: values[4],
              unit_label: values[5],
              minimum_milli: values[6],
              category: values[7],
              location: values[8],
              note: values[9],
              shopping_auto: values[10],
              version: 1,
            } as T,
          ],
          rowCount: 1,
        };
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
    get updateValues() {
      return updateValues;
    },
  };
}

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

  it("keeps shopping list reads side-effect free for viewers", async () => {
    const harness = poolFor({ role: "viewer" });
    const service = new StockService(harness.pool as never);

    await expect(service.listShoppingItems({ ...scope, role: "viewer" })).resolves.toEqual([]);
    expect(harness.statements.some((sql) => /INSERT INTO shopping_item/i.test(sql))).toBe(false);
    expect(harness.statements.some((sql) => /shopping_item_event/i.test(sql))).toBe(false);
  });

  it("reconciles a free item with a homonymous product into one automatic item", async () => {
    const harness = freeCollisionPool();
    const service = new StockService(harness.pool as never);

    await service.createProduct(scope, { name: "Arroz" }, "shopping-free-collision-001");
    const items = await service.listShoppingItems(scope);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: materializedItemId,
      productId,
      source: "automatic",
      quantity: "0.01",
    });
    expect(
      harness.statements.filter((sql) => /INSERT INTO shopping_item_event/i.test(sql)),
    ).toEqual([]);
  });

  it("rejects a product rename that would collide with an active free item", async () => {
    const harness = productRenameCollisionPool();
    const service = new StockService(harness.pool as never);

    await expect(
      service.updateProduct(scope, productId, { name: "Arroz livre", unit: "unit" }, 0),
    ).rejects.toBeInstanceOf(StockConflictError);
    expect(harness.statements.some((sql) => /UPDATE stock_product/i.test(sql))).toBe(false);
    const nameLock = harness.statements.findIndex((sql) => /pg_advisory_xact_lock/i.test(sql));
    const productLock = harness.statements.findIndex(
      (sql) => /FROM stock_product/i.test(sql) && /FOR UPDATE/i.test(sql),
    );
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(productLock).toBeGreaterThan(nameLock);
  });

  it("rejects restoring an archived product that collides with an active free item", async () => {
    const harness = productRenameCollisionPool(true);
    const service = new StockService(harness.pool as never);

    await expect(
      service.setArchived(scope, productId, false, "shopping-restore-0001", 0),
    ).rejects.toBeInstanceOf(StockConflictError);
    expect(harness.statements.some((sql) => /UPDATE stock_product/i.test(sql))).toBe(false);
    const nameLock = harness.statements.findIndex((sql) => /pg_advisory_xact_lock/i.test(sql));
    const productLock = harness.statements.findIndex(
      (sql) => /FROM stock_product/i.test(sql) && /FOR UPDATE/i.test(sql),
    );
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(productLock).toBeGreaterThan(nameLock);
  });

  it("keeps an active automatic row aligned with the edited product", async () => {
    const harness = productRenameSyncPool();
    const service = new StockService(harness.pool as never);

    await service.updateProduct(scope, productId, { name: "Arroz integral", unit: "unit" }, 0);
    const items = await service.listShoppingItems(scope);

    expect(items[0]).toMatchObject({
      id: materializedItemId,
      name: "Arroz integral",
      productId,
      source: "automatic",
      version: 1,
    });
    expect(
      harness.statements.some((sql) =>
        /SET name = p\.name, name_normalized = p\.name_normalized/i.test(sql),
      ),
    ).toBe(true);
  });

  it("preserves omitted product fields in a partial update", async () => {
    const harness = partialProductUpdatePool();
    const service = new StockService(harness.pool as never);

    const updated = await service.updateProduct(scope, productId, { name: "Arroz integral" }, 0);

    expect(updated).toMatchObject({
      name: "Arroz integral",
      unit: "package",
      unitLabel: "saco",
      minimum: "1",
      shoppingAuto: false,
      category: "Grãos",
      location: "Despensa",
      note: "Preferir integral",
    });
    expect(harness.updateValues?.slice(4, 11)).toEqual([
      "package",
      "saco",
      1000n,
      "Grãos",
      "Despensa",
      "Preferir integral",
      false,
    ]);
    const nameLock = harness.statements.findIndex((sql) => /pg_advisory_xact_lock/i.test(sql));
    const productLock = harness.statements.findIndex(
      (sql) => /FROM stock_product/i.test(sql) && /FOR UPDATE/i.test(sql),
    );
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(productLock).toBeGreaterThan(nameLock);
  });

  it("derives, purchases, suppresses, and releases an automatic item across reads and movement", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const beforeRead = harness.statements.length;
    const first = await service.listShoppingItems(scope);
    const readStatements = harness.statements.slice(beforeRead);
    expect(readStatements.some((sql) => /INSERT INTO shopping_item/i.test(sql))).toBe(false);
    expect(readStatements.some((sql) => /shopping_item_event/i.test(sql))).toBe(false);
    const listQuery = readStatements.find((sql) => /WITH visible_items/i.test(sql));
    expect(listQuery).toBeDefined();
    expect(listQuery).toMatch(/NULL::text AS last_changed_by/i);
    expect(listQuery).not.toMatch(/\$2::text AS last_changed_by/i);
    expect(listQuery).toMatch(/AND \(\$2::boolean OR i\.purchased = false\)/i);
    expect(listQuery).not.toMatch(/AND \(\$3::boolean/i);
    expect(listQuery).toMatch(/LIMIT \$3/i);
    expect(first).toHaveLength(1);
    const firstItem = first[0];
    expect(firstItem).toMatchObject({
      id: productId,
      productId,
      purchased: false,
      expenseTransactionId: null,
      lastChangedBy: null,
    });
    if (!firstItem) throw new Error("expected a derived shopping item");

    const beforePurchase = harness.statements.length;
    await service.purchaseShoppingItem(
      scope,
      firstItem.id,
      { addToStock: false },
      "shopping-behavior-false-001",
      firstItem.version,
    );
    await expect(service.listShoppingItems(scope)).resolves.toEqual([]);
    expect(readStatements.some((sql) => /finance_transaction/i.test(sql))).toBe(false);
    expect(
      harness.statements.slice(beforePurchase).some((sql) => /finance_transaction/i.test(sql)),
    ).toBe(false);

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

  it("links only an explicitly selected existing expense when completing a purchase", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);
    const item = (await service.listShoppingItems(scope))[0];
    if (!item) throw new Error("expected a derived shopping item");
    const expenseTransactionId = "0190f3c8-2a10-7abc-8def-1234567890af";

    const result = await service.purchaseShoppingItem(
      scope,
      item.id,
      { addToStock: false, expenseTransactionId },
      "shopping-expense-link-001",
      item.version,
    );
    expect(result.item.expenseTransactionId).toBe(expenseTransactionId);
    expect(harness.statements.some((sql) => /FROM finance_transaction/i.test(sql))).toBe(true);
  });

  it("rejects a link to a non-expense without changing the purchase", async () => {
    const harness = shoppingScenarioPool({ kind: "income", state: "posted" });
    const service = new StockService(harness.pool as never);
    const item = (await service.listShoppingItems(scope))[0];
    if (!item) throw new Error("expected a derived shopping item");

    await expect(
      service.purchaseShoppingItem(
        scope,
        item.id,
        {
          addToStock: false,
          expenseTransactionId: "0190f3c8-2a10-7abc-8def-1234567890af",
        },
        "shopping-expense-link-invalid-001",
        item.version,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(harness.statements.some((sql) => /SET purchased = true/i.test(sql))).toBe(false);
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

  it("rejects a second purchase through the old projected product id after no-stock completion", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const projected = (await service.listShoppingItems(scope))[0];
    if (!projected) throw new Error("expected a derived shopping item");
    await service.purchaseShoppingItem(
      scope,
      projected.id,
      { addToStock: false },
      "shopping-behavior-second-001",
      projected.version,
    );

    await expect(
      service.purchaseShoppingItem(
        scope,
        projected.id,
        { addToStock: false },
        "shopping-behavior-second-002",
        projected.version,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      harness.statements.filter((sql) => /INSERT INTO shopping_item_event/i.test(sql)),
    ).toHaveLength(2);
  });

  it("keeps a resynchronized automatic item at the product version used by If-Match", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const projected = (await service.listShoppingItems(scope))[0];
    if (!projected) throw new Error("expected a derived shopping item");
    await service.createMovement(
      scope,
      productId,
      { kind: "entry", quantity: "1" },
      "shopping-behavior-resync-001",
      projected.version,
    );

    const resynchronized = (await service.listShoppingItems(scope))[0];
    expect(resynchronized).toMatchObject({ productId, version: 1 });
  });

  it("rejects a stale If-Match after the automatic product changes", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const projected = (await service.listShoppingItems(scope))[0];
    if (!projected) throw new Error("expected a derived shopping item");
    await service.createMovement(
      scope,
      productId,
      { kind: "entry", quantity: "1" },
      "shopping-behavior-version-001",
      projected.version,
    );
    expect(harness.statements.some((sql) => sql.includes("SELECT p.workspace_id"))).toBe(true);
    const resynchronized = (await service.listShoppingItems(scope))[0];
    if (!resynchronized) throw new Error("expected a resynchronized shopping item");
    expect(resynchronized.id).toBe(materializedItemId);
    await service.createMovement(
      scope,
      productId,
      { kind: "entry", quantity: "1" },
      "shopping-behavior-version-003",
      1,
    );
    const invalidated = (await service.listShoppingItems(scope))[0];
    expect(invalidated).toMatchObject({ id: materializedItemId, productId, version: 2 });

    await expect(
      service.purchaseShoppingItem(
        scope,
        materializedItemId,
        { addToStock: false },
        "shopping-behavior-version-002",
        resynchronized.version,
      ),
    ).rejects.toMatchObject({ code: "version_conflict", currentVersion: 2 });
  });

  it("locks the automatic product before its shopping row", async () => {
    const harness = shoppingScenarioPool();
    const service = new StockService(harness.pool as never);

    const projected = (await service.listShoppingItems(scope))[0];
    if (!projected) throw new Error("expected a derived shopping item");
    await service.createMovement(
      scope,
      productId,
      { kind: "entry", quantity: "1" },
      "shopping-behavior-lock-order-001",
      projected.version,
    );
    const materialized = (await service.listShoppingItems(scope))[0];
    if (!materialized) throw new Error("expected a materialized shopping item");
    harness.statements.length = 0;

    await service.purchaseShoppingItem(
      scope,
      materialized.id,
      { addToStock: false },
      "shopping-behavior-lock-order-002",
      materialized.version,
    );

    const productLock = harness.statements.findIndex(
      (sql) => sql.includes("FROM stock_product") && sql.includes("FOR UPDATE"),
    );
    const itemLock = harness.statements.findIndex(
      (sql) => sql.includes("FROM shopping_item i") && sql.includes("FOR UPDATE"),
    );
    expect(productLock).toBeGreaterThanOrEqual(0);
    expect(itemLock).toBeGreaterThanOrEqual(0);
    expect(productLock).toBeLessThan(itemLock);
  });
});
