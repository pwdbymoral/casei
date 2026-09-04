import { describe, expect, it } from "vitest";

import { safeToSpendCardState } from "@/lib/today-dashboard";

describe("Today dashboard safe-to-spend card", () => {
  it("turns a negative gross projection into an actionable deficit", () => {
    expect(safeToSpendCardState({ available: true, gross: { minor: "-5000" } })).toEqual({
      kind: "deficit",
      ctaLabel: "Revisar déficit",
    });
  });

  it("keeps unavailable projections separate from a zero safe amount", () => {
    expect(safeToSpendCardState({ available: false, gross: null })).toEqual({
      kind: "unavailable",
      ctaLabel: "Revisar dados necessários",
    });
  });

  it("keeps a non-negative projection on the explanation path", () => {
    expect(safeToSpendCardState({ available: true, gross: { minor: "0" } })).toEqual({
      kind: "available",
      ctaLabel: "Entender o cálculo",
    });
  });
});
