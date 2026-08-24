import { describe, expect, it } from "vitest";
import {
  deriveStockState,
  formatStockQuantity,
  normalizeProductName,
  parseStockQuantity,
  shouldAutoAddToShopping,
  stockMovementAfter,
  suggestedShoppingQuantity,
} from "../src/stock.js";

describe("estoque", () => {
  it("normaliza nome para unicidade sem alterar o rótulo exibido", () => {
    expect(normalizeProductName("  Café   em pó ")).toEqual({
      display: "Café em pó",
      key: "cafe em po",
    });
  });

  it("usa quantidade fixa com até três casas e round-trip canônico", () => {
    expect(parseStockQuantity("1.500")).toBe(1500n);
    expect(formatStockQuantity(1500n)).toBe("1.5");
    expect(() => parseStockQuantity("1.0000")).toThrow();
    expect(() => parseStockQuantity("0")).toThrow();
    expect(parseStockQuantity("0", { allowZero: true })).toBe(0n);
  });

  it("deriva estados independentemente de cor ou apresentação", () => {
    expect(
      deriveStockState({ quantityMilli: null, minimumMilli: null, markedMissing: false }),
    ).toBe("unknown");
    expect(deriveStockState({ quantityMilli: 0n, minimumMilli: null, markedMissing: false })).toBe(
      "missing",
    );
    expect(
      deriveStockState({ quantityMilli: 1000n, minimumMilli: 1000n, markedMissing: false }),
    ).toBe("low");
    expect(
      deriveStockState({ quantityMilli: 1001n, minimumMilli: 1000n, markedMissing: false }),
    ).toBe("ok");
    expect(
      deriveStockState({ quantityMilli: 1000n, minimumMilli: null, markedMissing: true }),
    ).toBe("missing");
  });

  it("nunca aplica consumo negativo e correction define alvo", () => {
    expect(stockMovementAfter({ kind: "entry", beforeMilli: 500n, quantityMilli: 250n })).toBe(
      750n,
    );
    expect(stockMovementAfter({ kind: "consume", beforeMilli: 500n, quantityMilli: 250n })).toBe(
      250n,
    );
    expect(stockMovementAfter({ kind: "correction", beforeMilli: 500n, quantityMilli: 0n })).toBe(
      0n,
    );
    expect(() =>
      stockMovementAfter({ kind: "discard", beforeMilli: 500n, quantityMilli: 501n }),
    ).toThrow("negativo");
  });

  it("deriva a quantidade sugerida e decide quando um produto entra na lista", () => {
    expect(suggestedShoppingQuantity({ quantityMilli: 2_000n, minimumMilli: 5_000n })).toBe(3_000n);
    expect(suggestedShoppingQuantity({ quantityMilli: 5_000n, minimumMilli: 5_000n })).toBe(0n);
    expect(suggestedShoppingQuantity({ quantityMilli: 0n, minimumMilli: null })).toBeNull();
    expect(
      shouldAutoAddToShopping({ quantityMilli: 0n, minimumMilli: null, markedMissing: false }),
    ).toBe(true);
    expect(
      shouldAutoAddToShopping({
        quantityMilli: 8_000n,
        minimumMilli: 5_000n,
        markedMissing: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoAddToShopping({
        quantityMilli: 0n,
        minimumMilli: 2_000n,
        markedMissing: false,
        shoppingAuto: false,
      }),
    ).toBe(false);
  });
});
