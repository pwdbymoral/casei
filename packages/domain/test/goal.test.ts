import { describe, expect, it } from "vitest";
import {
  calculateGoalCoverage,
  calculateGoalReservation,
  goalAllocation,
  goalStatusAfterReservation,
} from "../src/goal.js";

describe("goal reservation subledger", () => {
  it("derives reserved amount from append-only movements", () => {
    expect(
      calculateGoalReservation({ allocatedMinor: 1000n, releasedMinor: 250n, spentMinor: 100n }),
    ).toBe(650n);
  });

  it("rejects releases or spends that make the virtual reserve negative", () => {
    expect(() =>
      calculateGoalReservation({ allocatedMinor: 100n, releasedMinor: 101n, spentMinor: 0n }),
    ).toThrow(/negativ/i);
  });

  it("requires explicit confirmation for an uncovered allocation", () => {
    expect(() =>
      goalAllocation({
        reservedMinor: 100n,
        walletBalanceMinor: 150n,
        amountMinor: 60n,
        allowUncovered: false,
      }),
    ).toThrow(/cobertura/i);
    expect(
      goalAllocation({
        reservedMinor: 100n,
        walletBalanceMinor: 150n,
        amountMinor: 60n,
        allowUncovered: true,
      }),
    ).toEqual({
      reservedMinor: 160n,
      uncoveredMinor: 10n,
    });
  });

  it("uses the workspace aggregate when sequential goals compete for coverage", () => {
    let workspaceReserved = 0n;
    workspaceReserved = goalAllocation({
      reservedMinor: workspaceReserved,
      walletBalanceMinor: 100n,
      amountMinor: 60n,
      allowUncovered: false,
    }).reservedMinor;
    expect(workspaceReserved).toBe(60n);
    expect(() =>
      goalAllocation({
        reservedMinor: workspaceReserved,
        walletBalanceMinor: 100n,
        amountMinor: 60n,
        allowUncovered: false,
      }),
    ).toThrow(/cobertura/i);
  });

  it("keeps coverage bounded and transitions completion from the target", () => {
    expect(calculateGoalCoverage(500n, 100n)).toEqual({ coveredMinor: 100n, uncoveredMinor: 400n });
    expect(calculateGoalCoverage(500n, -100n)).toEqual({ coveredMinor: 0n, uncoveredMinor: 500n });
    expect(
      goalStatusAfterReservation({ status: "active", targetMinor: 1000n, reservedMinor: 1000n }),
    ).toBe("completed");
    expect(
      goalStatusAfterReservation({ status: "completed", targetMinor: 1000n, reservedMinor: 900n }),
    ).toBe("active");
  });
});
