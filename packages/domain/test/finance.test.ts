import { describe, expect, it } from "vitest";
import {
  assertBalancedLedgerEvent,
  calculateSafeToSpend,
  calculateStatementDates,
  distributeInstallments,
  generateRecurrenceDates,
  requiredGoalContribution,
} from "../src/finance.js";
import { Money } from "../src/money.js";

const brl = (minor: bigint) => Money.fromTrusted(minor, "BRL" as never);

describe("financial domain", () => {
  it("requires balanced, non-zero, same-currency ledger postings", () => {
    expect(() =>
      assertBalancedLedgerEvent([
        { accountId: "wallet", amount: brl(100n) },
        { accountId: "expense", amount: brl(-100n) },
      ]),
    ).not.toThrow();
    expect(() =>
      assertBalancedLedgerEvent([
        { accountId: "wallet", amount: brl(100n) },
        { accountId: "expense", amount: brl(-99n) },
      ]),
    ).toThrow(/soma/);
    expect(() => assertBalancedLedgerEvent([{ accountId: "wallet", amount: brl(0n) }])).toThrow();
  });

  it("distributes installments exactly, with deterministic cents", () => {
    const parts = distributeInstallments(brl(100n), 3);
    expect(parts.map((part) => part.minor)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((sum, part) => sum + part.minor, 0n)).toBe(100n);
  });

  it("calculates card cycles at closing-day boundaries", () => {
    expect(calculateStatementDates("2026-08-31", 31, 5)).toEqual({
      periodStart: "2026-08-01",
      closingOn: "2026-08-31",
      dueOn: "2026-09-05",
    });
    expect(calculateStatementDates("2026-02-28", 31, 5)).toEqual({
      periodStart: "2026-02-01",
      closingOn: "2026-02-28",
      dueOn: "2026-03-05",
    });
    expect(calculateStatementDates("2026-08-31", 31, 5, "purchase").closingOn).toBe("2026-09-30");
  });

  it("generates recurrence dates idempotently for short months", () => {
    expect(generateRecurrenceDates("monthly", "2026-01-31", 3)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(generateRecurrenceDates("weekly", "2026-01-01", 3)).toEqual([
      "2026-01-01",
      "2026-01-08",
      "2026-01-15",
    ]);
  });

  it("calculates goal contribution and safe spending without negative output", () => {
    expect(requiredGoalContribution(1000n, 400n, 3)).toBe(200n);
    expect(requiredGoalContribution(1000n, 400n, 0)).toBeNull();
    expect(
      calculateSafeToSpend({
        balance: 1000n,
        plannedIncome: 500n,
        plannedOutflow: 700n,
        coveredReservations: 200n,
        safetyMargin: 100n,
      }),
    ).toEqual({ safe: 500n, gross: 500n });
    expect(
      calculateSafeToSpend({
        balance: 100n,
        plannedIncome: 0n,
        plannedOutflow: 500n,
        coveredReservations: 0n,
        safetyMargin: 0n,
      }),
    ).toEqual({ safe: 0n, gross: -400n });
  });
});
