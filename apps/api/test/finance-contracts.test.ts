import {
  createTransactionSchema,
  payStatementSchema,
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

  it("accepts partial card configuration updates and preserves explicit clearing", () => {
    expect(updateCreditCardSchema.parse({ closingDay: 31, holder: null, limit: null })).toEqual({
      closingDay: 31,
      holder: null,
      limit: null,
    });
    expect(() => updateCreditCardSchema.parse({})).toThrow();
    expect(() => updateCreditCardSchema.parse({ lastFour: "123" })).toThrow();
  });
});
