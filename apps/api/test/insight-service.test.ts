import { describe, expect, it } from "vitest";
import { calculateSafeToSpendAmounts } from "../src/insight-service.js";

describe("insight safe-to-spend calculation", () => {
  it("uses the canonical formula and exposes negative gross separately", () => {
    expect(
      calculateSafeToSpendAmounts({
        balance: 1_000n,
        plannedIncome: 500n,
        plannedOutflow: 700n,
        coveredReservations: 200n,
        safetyMargin: 100n,
      }),
    ).toEqual({ gross: 500n, safe: 500n });

    expect(
      calculateSafeToSpendAmounts({
        balance: 100n,
        plannedIncome: 0n,
        plannedOutflow: 300n,
        coveredReservations: 0n,
        safetyMargin: 0n,
      }),
    ).toEqual({ gross: -200n, safe: 0n });
  });
});
