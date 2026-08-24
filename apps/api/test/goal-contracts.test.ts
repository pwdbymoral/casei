import {
  createGoalSchema,
  goalAmountSchema,
  goalSchema,
  goalSpendSchema,
  updateGoalSchema,
} from "@casei/contracts";
import { describe, expect, it } from "vitest";

describe("goal contracts", () => {
  it("accepts a target with optional deadline and priority", () => {
    expect(
      createGoalSchema.parse({
        name: "Reserva de emergência",
        target: { currency: "BRL", minor: "100000" },
        deadline: "2027-12-31",
        priority: "high",
      }),
    ).toMatchObject({ name: "Reserva de emergência", priority: "high" });
  });

  it("requires explicit confirmation to reserve without coverage", () => {
    expect(
      goalAmountSchema.parse({ amount: { currency: "BRL", minor: "100" } }).allowUncovered,
    ).toBe(false);
    expect(
      goalAmountSchema.parse({ amount: { currency: "BRL", minor: "100" }, allowUncovered: true })
        .allowUncovered,
    ).toBe(true);
  });

  it("keeps spend details and goal response money canonical", () => {
    expect(
      goalSpendSchema.parse({ amount: { currency: "BRL", minor: "500" }, description: "Jantar" }),
    ).toMatchObject({
      amount: { minor: "500" },
      description: "Jantar",
    });
    expect(() => updateGoalSchema.parse({})).toThrow();
    expect(() =>
      goalSchema.parse({
        id: "0190f3c8-2a10-7abc-8def-1234567890ab",
        workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ac",
        name: "Meta",
        target: { currency: "BRL", minor: "1000" },
        reserved: { currency: "BRL", minor: "250" },
        uncovered: { currency: "BRL", minor: "0" },
        deadline: null,
        priority: "normal",
        status: "active",
        note: null,
        version: 0,
      }),
    ).not.toThrow();
  });
});
