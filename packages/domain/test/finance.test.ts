import { describe, expect, it } from "vitest";
import {
  assertBalancedLedgerEvent,
  calculateSafeToSpend,
  calculateStatementDates,
  canonicalCardPaymentPostings,
  canonicalLoanPaymentPostings,
  canonicalLoanPrincipalPostings,
  canonicalTransactionPostings,
  distributeInstallments,
  generateRecurrenceDates,
  generateRecurrenceDatesUntil,
  requiredGoalContribution,
} from "../src/finance.js";
import { Money } from "../src/money.js";
import { addLocalDateMonths, parseLocalDate } from "../src/time.js";

const brl = (minor: bigint) => Money.fromTrusted(minor, "BRL" as never);

describe("financial domain", () => {
  it("publishes loan principal and repayment without income or expense accounts", () => {
    const principal = canonicalLoanPrincipalPostings({
      direction: "lent",
      amount: brl(1_000n),
      accounts: { wallet: "wallet", loan: "receivable" },
    });
    expect(principal.map((entry) => [entry.accountId, entry.amount.minor])).toEqual([
      ["wallet", -1_000n],
      ["receivable", 1_000n],
    ]);
    const received = canonicalLoanPaymentPostings({
      direction: "lent",
      amount: brl(250n),
      accounts: { wallet: "wallet", loan: "receivable" },
    });
    expect(received.map((entry) => [entry.accountId, entry.amount.minor])).toEqual([
      ["wallet", 250n],
      ["receivable", -250n],
    ]);
    assertBalancedLedgerEvent(principal);
    assertBalancedLedgerEvent(received);
  });

  it("reverses cash direction for a borrowed loan", () => {
    const principal = canonicalLoanPrincipalPostings({
      direction: "borrowed",
      amount: brl(1_000n),
      accounts: { wallet: "wallet", loan: "payable" },
    });
    const payment = canonicalLoanPaymentPostings({
      direction: "borrowed",
      amount: brl(300n),
      accounts: { wallet: "wallet", loan: "payable" },
    });
    expect(principal.map((entry) => entry.amount.minor)).toEqual([1_000n, -1_000n]);
    expect(payment.map((entry) => entry.amount.minor)).toEqual([-300n, 300n]);
  });

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

  it("keeps wallet, card purchase and statement payment effects separate", () => {
    const accounts = {
      wallet: "wallet",
      income: "income",
      expense: "expense",
      adjustment: "adjustment",
    };
    const income = canonicalTransactionPostings({
      kind: "income",
      instrument: "wallet",
      amount: brl(100n),
      accounts,
    });
    expect(income).toEqual([
      { accountId: "wallet", amount: brl(100n) },
      { accountId: "income", amount: brl(-100n) },
    ]);
    const expense = canonicalTransactionPostings({
      kind: "expense",
      instrument: "wallet",
      amount: brl(40n),
      accounts,
    });
    expect(expense).toEqual([
      { accountId: "expense", amount: brl(40n) },
      { accountId: "wallet", amount: brl(-40n) },
    ]);
    const purchase = canonicalTransactionPostings({
      kind: "expense",
      instrument: "card",
      amount: brl(40n),
      accounts: { ...accounts, cardLiability: "card" },
    });
    expect(purchase).toEqual([
      { accountId: "expense", amount: brl(40n) },
      { accountId: "card", amount: brl(-40n) },
    ]);
    const payment = canonicalCardPaymentPostings({
      amount: brl(40n),
      wallet: "wallet",
      cardLiability: "card",
    });
    expect(payment).toEqual([
      { accountId: "wallet", amount: brl(-40n) },
      { accountId: "card", amount: brl(40n) },
    ]);
    expect(purchase.some((entry) => entry.accountId === "wallet")).toBe(false);
    expect(payment.some((entry) => entry.accountId === "expense")).toBe(false);
    assertBalancedLedgerEvent(purchase);
    assertBalancedLedgerEvent(payment);
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
    expect(generateRecurrenceDatesUntil("monthly", "2026-01-31", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
    expect(generateRecurrenceDatesUntil("annual", "2028-02-29", "2032-02-29")).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("calculates a civil twelve-month horizon without UTC drift", () => {
    const leapStart = parseLocalDate("2028-02-29");
    const monthStart = parseLocalDate("2026-01-31");
    if (!leapStart.ok || !monthStart.ok) throw new Error("test date should be valid");
    expect(addLocalDateMonths(leapStart.value, 12)).toBe("2029-02-28");
    expect(addLocalDateMonths(monthStart.value, 12)).toBe("2027-01-31");
  });

  it("preserves years below 100 when adding civil months", () => {
    const yearOne = parseLocalDate("0001-01-31");
    const yearNinetyNine = parseLocalDate("0099-12-31");
    if (!yearOne.ok || !yearNinetyNine.ok) throw new Error("test date should be valid");

    expect(addLocalDateMonths(yearOne.value, 1)).toBe("0001-02-28");
    expect(addLocalDateMonths(yearNinetyNine.value, 1)).toBe("0100-01-31");
  });

  it("rejects impossible civil dates instead of relying on UTC rollover", () => {
    expect(parseLocalDate("2026-02-29").ok).toBe(false);
    expect(parseLocalDate("2028-02-29").ok).toBe(true);
    expect(parseLocalDate("2026-04-31").ok).toBe(false);
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
