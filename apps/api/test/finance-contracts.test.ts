import {
  createRecurrenceSchema,
  createTransactionSchema,
  insightWindowQuerySchema,
  payStatementSchema,
  recurrenceTransitionSchema,
  safeToSpendQuerySchema,
  settleTransactionSchema,
  transactionListQuerySchema,
  updateCreditCardSchema,
} from "@casei/contracts";
import { describe, expect, it } from "vitest";

describe("finance contracts", () => {
  it("rejects impossible civil dates before opening a command", () => {
    expect(() =>
      createTransactionSchema.parse({
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
        occurredOn: "2026-02-29",
      }),
    ).toThrow();
  });

  it("accepts an explicit civil payment date", () => {
    expect(payStatementSchema.parse({ occurredOn: "2028-02-29" })).toMatchObject({
      occurredOn: "2028-02-29",
      allowCredit: false,
    });
  });

  it("accepts an effective partial settlement and defaults the amount", () => {
    expect(
      settleTransactionSchema.parse({
        amount: { currency: "BRL", minor: "250" },
        occurredOn: "2028-02-29",
      }),
    ).toEqual({
      amount: { currency: "BRL", minor: "250" },
      occurredOn: "2028-02-29",
    });
    expect(settleTransactionSchema.parse({})).toEqual({});
  });

  it("leaves the transaction date to the workspace clock when omitted", () => {
    expect(
      createTransactionSchema.parse({
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
      }),
    ).not.toHaveProperty("occurredOn");
  });

  it("validates recurrence bounds and variable estimates", () => {
    expect(
      createRecurrenceSchema.parse({
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
        frequency: "monthly",
        startOn: "2026-01-31",
        variable: true,
        estimatedAmount: { currency: "BRL", minor: "120" },
      }),
    ).toMatchObject({ variable: true, estimatedAmount: { minor: "120" } });
    expect(() =>
      createRecurrenceSchema.parse({
        kind: "expense",
        amount: { currency: "BRL", minor: "100" },
        frequency: "monthly",
        startOn: "2026-03-01",
        endOn: "2026-02-28",
      }),
    ).toThrow("posterior");
    expect(recurrenceTransitionSchema.parse({})).toEqual({});
    expect(recurrenceTransitionSchema.parse({ effectiveOn: "2028-02-29" })).toEqual({
      effectiveOn: "2028-02-29",
    });
  });

  it("parses timeline filters and rejects an inverted period", () => {
    expect(
      transactionListQuerySchema.parse({
        search: "mercado",
        from: "2026-08-01",
        to: "2026-08-31",
        state: "posted",
        kind: "expense",
        limit: "25",
      }),
    ).toMatchObject({ search: "mercado", from: "2026-08-01", to: "2026-08-31", limit: 25 });

    expect(() =>
      transactionListQuerySchema.parse({ from: "2026-09-01", to: "2026-08-01" }),
    ).toThrow();
  });

  it("parses deterministic insight windows and safe-to-spend horizons", () => {
    expect(insightWindowQuerySchema.parse({ from: "2026-08-01", to: "2026-08-31" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(safeToSpendQuerySchema.parse({ horizonDays: "45" })).toEqual({ horizonDays: 45 });
    expect(() =>
      insightWindowQuerySchema.parse({ from: "2026-09-01", to: "2026-08-01" }),
    ).toThrow();
    expect(() =>
      insightWindowQuerySchema.parse({ asOf: "2026-09-01", from: "2026-09-02" }),
    ).toThrow();
    expect(() =>
      insightWindowQuerySchema.parse({ asOf: "2026-09-01", to: "2026-08-31" }),
    ).toThrow();
  });

  it("accepts partial card configuration updates and preserves explicit clearing", () => {
    expect(updateCreditCardSchema.parse({ closingDay: 31, holder: null, limit: null })).toEqual({
      closingDay: 31,
      holder: null,
      limit: null,
    });
    expect(() => updateCreditCardSchema.parse({})).toThrow();
    expect(() => updateCreditCardSchema.parse({ lastFour: "123" })).toThrow();
    expect(() => updateCreditCardSchema.parse({ limit: { currency: "BRL", minor: "-1" } })).toThrow(
      "greater than or equal to zero",
    );
  });
});
