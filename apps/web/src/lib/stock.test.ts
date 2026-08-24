import { describe, expect, it } from "vitest";
import { createFixtureStockAdapter, createHttpStockAdapter } from "./stock";

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
});
