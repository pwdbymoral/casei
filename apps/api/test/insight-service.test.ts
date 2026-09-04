import { describe, expect, it } from "vitest";
import {
  calculateSafeToSpendAmounts,
  projectCashFlow,
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

describe("12-month cash-flow projection", () => {
  it("reconciles each point with dated source events and keeps unknown values explicit", () => {
    const projection = projectCashFlow({
      asOf: "2026-08-24",
      months: 2,
      currency: "BRL",
      startingBalance: 100_000n,
      events: [
        {
          id: "income-1",
          date: "2026-08-30",
          direction: "income",
          amount: 50_000n,
          source: { type: "transaction", id: "income-1", label: "Salário" },
        },
        {
          id: "rent-1",
          date: "2026-09-05",
          direction: "outflow",
          amount: 80_000n,
          source: { type: "recurrence", id: "rent", label: "Aluguel" },
        },
        {
          id: "variable-1",
          date: "2026-10-01",
          direction: "outflow",
          amount: null,
          source: { type: "recurrence", id: "variable", label: "Conta variável" },
        },
      ],
    });

    expect(projection.points).toHaveLength(2);
    expect(projection.points[0]).toMatchObject({
      date: "2026-09-24",
      balance: { currency: "BRL", minor: "70000" },
      delta: { currency: "BRL", minor: "-30000" },
      unknownEventCount: 0,
    });
    expect(projection.points[0]?.events.map((event) => event.id)).toEqual(["income-1", "rent-1"]);
    expect(projection.points[1]).toMatchObject({
      date: "2026-10-24",
      balance: { currency: "BRL", minor: "70000" },
      delta: { currency: "BRL", minor: "0" },
      unknownEventCount: 1,
    });
    expect(projection.points[1]?.events[0]).toMatchObject({
      id: "variable-1",
      amount: null,
      direction: "outflow",
    });
    expect(projection.confidence).toEqual({
      level: "medium",
      reasons: ["evento_variavel_sem_estimativa"],
    });
  });

  it("does not mutate the input events and rejects events outside the horizon", () => {
    const events = [
      {
        id: "outside",
        date: "2027-01-01",
        direction: "income" as const,
        amount: 1n,
        source: { type: "transaction" as const, id: "outside", label: "Fora" },
      },
    ];
    const projection = projectCashFlow({
      asOf: "2026-01-01",
      months: 1,
      currency: "BRL",
      startingBalance: 0n,
      events,
    });
    expect(projection.points[0]?.events).toEqual([]);
    expect(events[0]?.date).toBe("2027-01-01");
  });

  it("brings overdue commitments into the first point instead of dropping them", () => {
    const projection = projectCashFlow({
      asOf: "2026-08-24",
      months: 1,
      currency: "BRL",
      startingBalance: 1_000n,
      events: [
        {
          id: "overdue",
          date: "2026-08-01",
          direction: "outflow",
          amount: 250n,
          source: { type: "transaction", id: "overdue", label: "Conta vencida" },
        },
      ],
    });
    expect(projection.points[0]).toMatchObject({
      balance: { minor: "750" },
      delta: { minor: "-250" },
    });
    expect(projection.points[0]?.events[0]?.date).toBe("2026-08-01");
  });
});
