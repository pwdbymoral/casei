import { describe, expect, it } from "vitest";

import {
  applySimulationChanges,
  createHttpReportAdapter,
  type FinancialReport,
  reportExportPath,
  reportFiltersFromSearchParams,
  simulationToPlannedTransaction,
} from "./reports";

const report: FinancialReport = {
  asOf: "2026-08-31",
  from: "2026-08-01",
  to: "2026-08-31",
  currency: "BRL",
  filters: { kind: "all", categoryId: null },
  totals: {
    income: { currency: "BRL", minor: "1000" },
    expense: { currency: "BRL", minor: "200" },
    net: { currency: "BRL", minor: "800" },
    transactionCount: 2,
  },
  monthly: [
    {
      month: "2026-08",
      income: { currency: "BRL", minor: "1000" },
      expense: { currency: "BRL", minor: "200" },
      net: { currency: "BRL", minor: "800" },
      transactionCount: 2,
    },
  ],
  categories: [
    {
      categoryId: "market",
      categoryName: "Mercado",
      income: { currency: "BRL", minor: "0" },
      expense: { currency: "BRL", minor: "200" },
      net: { currency: "BRL", minor: "-200" },
      transactionCount: 1,
    },
  ],
  reconciliation: {
    source: "published_ledger",
    transactionCount: 2,
    income: { currency: "BRL", minor: "1000" },
    expense: { currency: "BRL", minor: "200" },
    export: {
      domain: "transactions",
      format: "csv",
      from: "2026-08-01",
      to: "2026-08-31",
      kind: "all",
      categoryId: null,
    },
  },
};

describe("report filters and export reconciliation", () => {
  it("keeps filters in the URL and points export at the same period", () => {
    const filters = reportFiltersFromSearchParams(
      new URLSearchParams("from=2026-07-01&to=2026-07-31&kind=expense&categoryId=market"),
      { from: "2026-08-01", to: "2026-08-31" },
    );
    expect(filters).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
      kind: "expense",
      categoryId: "market",
    });
    expect(reportExportPath(filters)).toBe(
      "/app/data?from=2026-07-01&to=2026-07-31&kind=expense&categoryId=market&domain=transactions",
    );
  });

  it("sends the workspace-scoped report filters to the versioned endpoint", async () => {
    const requests: string[] = [];
    const adapter = createHttpReportAdapter({
      baseUrl: "https://api.test",
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify(report), { status: 200 });
      },
    });
    await adapter.getReport("space/1", {
      from: "2026-08-01",
      to: "2026-08-31",
      kind: "expense",
      categoryId: "market",
    });
    expect(requests).toEqual([
      "https://api.test/v1/workspaces/space%2F1/insights/reports?from=2026-08-01&to=2026-08-31&kind=expense&categoryId=market",
    ]);
  });
});

describe("isolated report simulations", () => {
  it("adds a hypothetical event without mutating the canonical report or source events", () => {
    const simulated = applySimulationChanges(
      report,
      [
        {
          id: "expense-1",
          kind: "expense",
          amountMinor: "200",
          occurredOn: "2026-08-15",
          categoryId: "market",
          categoryName: "Mercado",
        },
      ],
      [
        {
          id: "simulation-1",
          operation: "add",
          event: {
            id: "hypothetical-1",
            kind: "expense",
            amountMinor: "300",
            occurredOn: "2026-08-20",
            categoryId: "leisure",
            categoryName: "Lazer",
          },
        },
      ],
    );
    expect(simulated.totals).toMatchObject({
      income: { minor: "1000" },
      expense: { minor: "500" },
      net: { minor: "500" },
      transactionCount: 3,
    });
    expect(simulated.categories.find((item) => item.categoryId === "leisure")).toMatchObject({
      expense: { minor: "300" },
    });
    expect(report.totals.expense.minor).toBe("200");
    expect(report.categories).toHaveLength(1);
  });

  it("can replace a source event only in the temporary copy", () => {
    const simulated = applySimulationChanges(
      report,
      [
        {
          id: "expense-1",
          kind: "expense",
          amountMinor: "200",
          occurredOn: "2026-08-15",
          categoryId: "market",
          categoryName: "Mercado",
        },
      ],
      [
        {
          id: "simulation-2",
          operation: "replace",
          eventId: "expense-1",
          event: {
            id: "expense-1",
            kind: "expense",
            amountMinor: "500",
            occurredOn: "2026-09-01",
            categoryId: "leisure",
            categoryName: "Lazer",
          },
        },
      ],
    );
    expect(simulated.totals.expense.minor).toBe("500");
    expect(simulated.totals.transactionCount).toBe(2);
    expect(simulated.monthly.map((item) => item.month)).toEqual(["2026-08", "2026-09"]);
    expect(report.totals.expense.minor).toBe("200");
  });

  it("creates a planned transaction only for the explicit apply action", () => {
    expect(
      simulationToPlannedTransaction(
        {
          id: "hypothetical-1",
          kind: "expense",
          amountMinor: "300",
          occurredOn: "2026-08-20",
          categoryId: "leisure",
          categoryName: "Lazer",
        },
        "BRL",
      ),
    ).toEqual({
      kind: "expense",
      amount: { currency: "BRL", minor: "300" },
      occurredOn: "2026-08-20",
      dueOn: "2026-08-20",
      state: "planned",
      description: "Planejamento criado a partir de uma simulação",
      categoryId: "leisure",
      cardId: null,
    });
  });
});
