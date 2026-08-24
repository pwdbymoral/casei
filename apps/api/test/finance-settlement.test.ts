import { describe, expect, it } from "vitest";
import { calculateSettlement } from "../src/finance-service.js";

describe("partial settlement calculation", () => {
  it("publishes only the requested delta and keeps the commitment partial", () => {
    expect(
      calculateSettlement({ plannedMinor: 1000n, settledMinor: 0n, effectiveMinor: 250n }),
    ).toEqual({ amountMinor: 250n, settledMinor: 250n, state: "partially_settled" });
  });

  it("posts the remaining balance when the effective amount is omitted", () => {
    expect(calculateSettlement({ plannedMinor: 1000n, settledMinor: 250n })).toEqual({
      amountMinor: 750n,
      settledMinor: 1000n,
      state: "posted",
    });
  });

  it("rejects zero, duplicate and excess settlements", () => {
    expect(() =>
      calculateSettlement({ plannedMinor: 1000n, settledMinor: 1000n, effectiveMinor: 1n }),
    ).toThrow(/excede/);
    expect(() => calculateSettlement({ plannedMinor: 1000n, settledMinor: 1000n })).toThrow(
      /maior que zero/,
    );
    expect(() =>
      calculateSettlement({ plannedMinor: 1000n, settledMinor: 250n, effectiveMinor: 0n }),
    ).toThrow(/maior que zero/);
    expect(() =>
      calculateSettlement({ plannedMinor: 1000n, settledMinor: 750n, effectiveMinor: 251n }),
    ).toThrow(/excede/);
  });
});
