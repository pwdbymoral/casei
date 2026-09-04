import {
  cancelTransactionSchema,
  createLoanSchema,
  createRecurrenceSchema,
  createStatementAdjustmentSchema,
  createStatementRefundSchema,
  createTransactionSchema,
  insightReportQuerySchema,
  insightReportSchema,
  insightWindowQuerySchema,
  installmentCancelSchema,
  installmentPlanUpdateSchema,
  installmentPreviewSchema,
  installmentUpdateSchema,
  loanPaymentSchema,
  loanPaymentViewSchema,
  payStatementSchema,
  projectionQuerySchema,
  projectionSchema,
  recurrenceTransitionSchema,
  safeToSpendQuerySchema,
  settleTransactionSchema,
  transactionListQuerySchema,
  updateCreditCardSchema,
  updateRecurrenceSchema,
  updateTransactionSchema,
  walletAdjustmentInputSchema,
  walletAdjustmentPreviewInputSchema,
} from "@casei/contracts";
import { describe, expect, it } from "vitest";

describe("finance contracts", () => {
  it("requires explicit confirmation to cancel a transaction", () => {
    expect(cancelTransactionSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(() => cancelTransactionSchema.parse({ confirm: false })).toThrow();
  });

  it("requires at least one editable field and accepts nullable due dates", () => {
    expect(() => updateTransactionSchema.parse({})).toThrow("ao menos um campo");
    expect(
      updateTransactionSchema.parse({
        amount: { currency: "BRL", minor: "250" },
        dueOn: null,
        description: "Feira",
      }),
    ).toEqual({
      amount: { currency: "BRL", minor: "250" },
      dueOn: null,
      description: "Feira",
    });
  });

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

  it("requires an explicit reason and positive amount for statement adjustments", () => {
    expect(
      createStatementAdjustmentSchema.parse({
        kind: "fee",
        amount: { currency: "BRL", minor: "1250" },
        description: "Tarifa de avaliação emergencial",
        occurredOn: "2028-02-29",
      }),
    ).toMatchObject({ kind: "fee", description: "Tarifa de avaliação emergencial" });
    expect(() =>
      createStatementAdjustmentSchema.parse({
        kind: "interest",
        amount: { currency: "BRL", minor: "0" },
        description: "Juros",
      }),
    ).toThrow();
    expect(() =>
      createStatementAdjustmentSchema.parse({
        kind: "charge",
        amount: { currency: "BRL", minor: "100" },
        description: "   ",
      }),
    ).toThrow();
  });

  it("requires the original transaction when registering a refund", () => {
    expect(
      createStatementRefundSchema.parse({
        sourceTransactionId: "0190f3c8-2a10-7abc-8def-1234567890ac",
        amount: { currency: "BRL", minor: "100" },
      }),
    ).toMatchObject({ sourceTransactionId: "0190f3c8-2a10-7abc-8def-1234567890ac" });
    expect(() =>
      createStatementRefundSchema.parse({ amount: { currency: "BRL", minor: "100" } }),
    ).toThrow();
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

  it("validates the simple IOU contract and principal payment", () => {
    expect(
      createLoanSchema.parse({
        direction: "lent",
        counterparty: "Ana",
        principal: { currency: "BRL", minor: "1000" },
        occurredOn: "2028-02-29",
        dueOn: "2028-03-31",
      }),
    ).toMatchObject({ direction: "lent", counterparty: "Ana" });
    expect(loanPaymentSchema.parse({ amount: { currency: "BRL", minor: "250" } })).toEqual({
      amount: { currency: "BRL", minor: "250" },
    });
    expect(
      loanPaymentViewSchema.parse({
        id: "0190f3c8-2a10-7abc-8def-1234567890ac",
        loanId: "0190f3c8-2a10-7abc-8def-1234567890ad",
        amount: { currency: "BRL", minor: "250" },
        occurredOn: "2028-03-01",
      }),
    ).toMatchObject({ amount: { minor: "250" }, occurredOn: "2028-03-01" });
    expect(() =>
      createLoanSchema.parse({
        direction: "borrowed",
        counterparty: "Ana",
        principal: { currency: "BRL", minor: "1000" },
        occurredOn: "2028-03-01",
        dueOn: "2028-02-29",
      }),
    ).toThrow("anterior");
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
    expect(
      updateRecurrenceSchema.parse({
        scope: "this_and_future",
        effectiveOn: "2028-02-29",
        amount: { currency: "BRL", minor: "100" },
      }),
    ).toMatchObject({ scope: "this_and_future" });
    expect(() =>
      updateRecurrenceSchema.parse({
        scope: "this",
        effectiveOn: "2028-02-29",
        endOn: "2028-12-31",
      }),
    ).toThrow("somente valor e descrição");
  });

  it("validates installment preview and future edit commands", () => {
    expect(
      installmentPreviewSchema.parse({
        total: { currency: "BRL", minor: "1000" },
        count: 3,
        firstDueOn: "2028-02-29",
      }),
    ).toMatchObject({ count: 3, description: "" });
    expect(() => installmentPlanUpdateSchema.parse({})).toThrow("ao menos um campo");
    expect(installmentUpdateSchema.parse({ dueOn: "2028-03-31" })).toEqual({
      dueOn: "2028-03-31",
    });
    expect(installmentCancelSchema.parse({ confirm: true })).toEqual({ confirm: true });
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

  it("bounds the projection horizon to the twelve-month MVP window", () => {
    expect(projectionQuerySchema.parse({ asOf: "2026-08-24", months: "12" })).toEqual({
      asOf: "2026-08-24",
      months: 12,
    });
    expect(() => projectionQuerySchema.parse({ months: 13 })).toThrow();
    expect(() => projectionQuerySchema.parse({ asOf: "2026-02-29" })).toThrow();
    expect(() => projectionSchema.parse({})).toThrow();
  });

  it("parses report filters and exposes the canonical response contract", () => {
    expect(
      insightReportQuerySchema.parse({ from: "2026-08-01", to: "2026-08-31", kind: "expense" }),
    ).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      kind: "expense",
    });
    expect(() =>
      insightReportQuerySchema.parse({ from: "2026-09-01", to: "2026-08-31" }),
    ).toThrow();
    expect(() => insightReportSchema.parse({})).toThrow();
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

  it("accepts a signed observed wallet balance and requires an adjustment reason", () => {
    expect(
      walletAdjustmentPreviewInputSchema.parse({
        observedBalance: { currency: "BRL", minor: "-250" },
      }),
    ).toEqual({ observedBalance: { currency: "BRL", minor: "-250" } });
    expect(() =>
      walletAdjustmentPreviewInputSchema.parse({
        observedBalance: { currency: "BRL", minor: "-1000000000000000" },
      }),
    ).toThrow("minor is outside the supported range");
    expect(() =>
      walletAdjustmentInputSchema.parse({
        observedBalance: { currency: "BRL", minor: "1000" },
        reason: "   ",
      }),
    ).toThrow();
    expect(
      walletAdjustmentInputSchema.parse({
        observedBalance: { currency: "BRL", minor: "1000" },
        reason: "Conferência do dinheiro disponível",
      }),
    ).toEqual({
      observedBalance: { currency: "BRL", minor: "1000" },
      reason: "Conferência do dinheiro disponível",
    });
  });
});
