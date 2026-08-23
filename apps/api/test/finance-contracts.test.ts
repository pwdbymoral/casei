import { createTransactionSchema, payStatementSchema } from "@casei/contracts";
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
});
