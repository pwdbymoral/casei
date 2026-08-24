import { describe, expect, it } from "vitest";
import {
  clearAllStockOfflineSnapshots,
  createFixtureStockAdapter,
  createHttpStockAdapter,
} from "./stock";

const workspaceA = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
const workspaceB = "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202";

describe("stock adapter", () => {
  it("keeps fixture data isolated by workspace and uses fixed-point quick actions", async () => {
    const adapter = createFixtureStockAdapter();
    const a = await adapter.listProducts(workspaceA);
    const b = await adapter.listProducts(workspaceB);
    expect(a.some((product) => product.name === "Arroz integral")).toBe(true);
    expect(b.some((product) => product.name === "Arroz integral")).toBe(false);
    const product = a.find((item) => item.name === "Arroz integral");
    if (!product) throw new Error("fixture product missing");
    const moved = await adapter.createMovement(workspaceA, product, {
      kind: "entry",
      quantity: "0.001",
    });
    expect(moved.product.quantity).toBe("2.001");
    const history = await adapter.listMovements(workspaceA, product.id);
    expect(history[0]?.quantity).toBe("0.001");
  });

  it("keeps projected authorship absent and synchronizes automatic rows after product edits", async () => {
    const adapter = createFixtureStockAdapter();
    const product = (await adapter.listProducts(workspaceA)).find((item) => item.name === "Leite");
    if (!product) throw new Error("fixture product missing");

    const before = await adapter.listShoppingItems(workspaceA);
    expect(before.find((item) => item.productId === product.id)).toMatchObject({
      name: "Leite",
      unit: "L",
      lastChangedBy: null,
    });

    const updated = await adapter.updateProduct(workspaceA, product, {
      name: "Leite integral",
      unit: "package",
    });
    expect(updated).toMatchObject({
      name: "Leite integral",
      unit: "package",
      minimum: "2",
    });

    expect(
      (await adapter.listShoppingItems(workspaceA)).find((item) => item.productId === product.id),
    ).toMatchObject({
      name: "Leite integral",
      unit: "package",
      lastChangedBy: "user_fixture_marina",
      version: updated.version,
    });
  });

  it("sends If-Match and idempotency headers through the HTTP adapter", async () => {
    const requests: Request[] = [];
    const adapter = createHttpStockAdapter({
      baseUrl: "https://casei.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ id: "product", version: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await adapter.archive(workspaceA, {
      id: "019b5d9e-3c12-7a03-8d47-7b5b5dd7a203",
      workspaceId: workspaceA,
      name: "Arroz",
      unit: "kg",
      unitLabel: null,
      quantity: "1",
      minimum: null,
      markedMissing: false,
      shoppingAuto: true,
      state: "ok",
      category: null,
      location: null,
      note: null,
      archived: false,
      version: 3,
    });
    expect(requests[0]?.headers.get("If-Match")).toBe('"v3"');
    expect(requests[0]?.headers.get("Idempotency-Key")).toMatch(/^stock-/);
  });
  it("reuses one operation-scoped idempotency key after a network retry", async () => {
    let attempts = 0;
    const keys: string[] = [];
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) throw new TypeError("network interrupted");
      return Response.json({ id: "product", version: 0 }, { status: 201 });
    };
    const adapter = createHttpStockAdapter({ fetch });
    const input = { name: "Arroz" };
    await expect(
      adapter.createProduct(workspaceA, input, "stock-operation-retry-001"),
    ).rejects.toThrow("Esta ação precisa de conexão.");
    await expect(
      adapter.createProduct(workspaceA, input, "stock-operation-retry-001"),
    ).resolves.toMatchObject({ id: "product" });
    expect(keys).toEqual(["stock-operation-retry-001", "stock-operation-retry-001"]);
  });

  it("reads a cached snapshot offline and clears it when the workspace ends", async () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return data.size;
        },
        key: (index: number) => [...data.keys()][index] ?? null,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
      } satisfies Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
    });
    const cachedProduct = {
      id: "cached-product",
      workspaceId: workspaceA,
      name: "Arroz",
      unit: "unit" as const,
      unitLabel: null,
      quantity: "1",
      minimum: null,
      markedMissing: false,
      shoppingAuto: true,
      state: "ok" as const,
      category: null,
      location: null,
      note: null,
      archived: false,
      version: 1,
    };
    let online = true;
    const fetch = async () => {
      if (!online) throw new TypeError("offline");
      return Response.json({ items: [cachedProduct], page: { nextCursor: null, hasMore: false } });
    };
    try {
      const adapter = createHttpStockAdapter({ fetch });
      await expect(adapter.listProducts(workspaceA)).resolves.toEqual([cachedProduct]);
      await expect(adapter.listProducts(workspaceB)).resolves.toEqual([cachedProduct]);
      online = false;
      const offlineAdapter = createHttpStockAdapter({ fetch });
      await expect(offlineAdapter.listProducts(workspaceA)).resolves.toEqual([cachedProduct]);
      expect(offlineAdapter.lastReadWasCached).toBe(true);
      await expect(
        offlineAdapter.createProduct(workspaceA, { name: "Leite" }, "stock-offline-001"),
      ).rejects.toMatchObject({ code: "offline_required" });
      await expect(offlineAdapter.listProducts(workspaceB)).resolves.toEqual([cachedProduct]);
      clearAllStockOfflineSnapshots();
      await expect(offlineAdapter.listProducts(workspaceA)).rejects.toMatchObject({
        code: "offline_required",
      });
      await expect(offlineAdapter.listProducts(workspaceB)).rejects.toMatchObject({
        code: "offline_required",
      });

      let resolvePending!: (response: Response) => void;
      const pendingResponse = new Promise<Response>((resolve) => {
        resolvePending = resolve;
      });
      const pendingAdapter = createHttpStockAdapter({ fetch: async () => pendingResponse });
      const pendingRead = pendingAdapter.listProducts(workspaceA);
      clearAllStockOfflineSnapshots();
      resolvePending(
        Response.json({ items: [cachedProduct], page: { nextCursor: null, hasMore: false } }),
      );
      await expect(pendingRead).resolves.toEqual([cachedProduct]);
      online = false;
      const afterLateReadAdapter = createHttpStockAdapter({ fetch });
      await expect(afterLateReadAdapter.listProducts(workspaceA)).rejects.toMatchObject({
        code: "offline_required",
      });
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("keeps purchase confirmation explicit in the shopping adapter", async () => {
    const requests: Request[] = [];
    const adapter = createHttpStockAdapter({
      baseUrl: "https://casei.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ item: {}, product: null, movement: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await adapter.purchaseShoppingItem(
      workspaceA,
      {
        id: "019b5d9e-3c12-7a03-8d47-7b5b5dd7a203",
        workspaceId: workspaceA,
        productId: "019b5d9e-3c12-7a03-8d47-7b5b5dd7a204",
        name: "Leite",
        source: "automatic",
        quantity: "2",
        unit: "L",
        unitLabel: null,
        note: null,
        purchased: false,
        purchasedAt: null,
        lastChangedBy: "user_fixture_marina",
        version: 4,
      },
      { addToStock: true, quantity: "1.5" },
    );
    expect(requests[0]?.headers.get("If-Match")).toBe('"v4"');
    expect(await requests[0]?.json()).toEqual({ addToStock: true, quantity: "1.5" });
  });
});
