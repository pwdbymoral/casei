import { describe, expect, it } from "vitest";
import {
  calculateSafeToSpendAmounts,
  resolveInsightWindow,
  resolveReportWindow,
} from "../src/insight-service.js";

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

  it("validates the effective window after applying asOf defaults", () => {
    expect(resolveInsightWindow({ asOf: "2026-09-01", from: "2026-08-31" })).toEqual({
      from: "2026-08-31",
      to: "2026-09-01",
    });
    expect(() => resolveInsightWindow({ asOf: "2026-09-01", from: "2026-09-02" })).toThrow();
    expect(() => resolveInsightWindow({ asOf: "2026-09-01", to: "2026-08-31" })).toThrow();
  });

  it("defaults reports to the current calendar month and rejects future inversion", () => {
    expect(resolveReportWindow({ asOf: "2026-08-24" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-24",
    });
    expect(
      resolveReportWindow({ asOf: "2026-08-24", from: "2026-07-15", to: "2026-08-31" }),
    ).toEqual({ from: "2026-07-15", to: "2026-08-31" });
    expect(() => resolveReportWindow({ asOf: "2026-08-24", from: "2026-09-01" })).toThrow();
  });
});
