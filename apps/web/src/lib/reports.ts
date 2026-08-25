import { configuredApiOrigin } from "./api-origin";
import type { CreateTransactionInput, Transaction } from "./finance";

export type ReportKind = "all" | "income" | "expense";
export type ReportFilters = {
  from: string;
  to: string;
  kind: ReportKind;
  categoryId: string | null;
};
export type ReportMoney = { currency: string; minor: string };
export type ReportPeriod = {
  month: string;
  income: ReportMoney;
  expense: ReportMoney;
  net: ReportMoney;
  transactionCount: number;
};
export type ReportCategory = {
  categoryId: string | null;
  categoryName: string;
  income: ReportMoney;
  expense: ReportMoney;
  net: ReportMoney;
  transactionCount: number;
};
export type FinancialReport = {
  asOf: string;
  from: string;
  to: string;
  currency: string;
  filters: { kind: ReportKind; categoryId: string | null };
  totals: {
    income: ReportMoney;
    expense: ReportMoney;
    net: ReportMoney;
    transactionCount: number;
  };
  monthly: ReportPeriod[];
  categories: ReportCategory[];
  reconciliation: {
    source: "published_ledger";
    transactionCount: number;
    income: ReportMoney;
    expense: ReportMoney;
    export: {
      domain: "transactions";
      format: "csv";
      from: string;
      to: string;
      kind: ReportKind;
      categoryId: string | null;
    };
  };
};

export type ReportAdapter = {
  getReport(
    workspaceId: string,
    filters: ReportFilters & { asOf?: string },
  ): Promise<FinancialReport>;
};

export class ReportAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReportAdapterError";
  }
}

const unavailable = async (..._args: never[]): Promise<never> => {
  throw new ReportAdapterError(
    "Seus relatórios não estão disponíveis. Entre novamente para continuar.",
    401,
  );
};

export const unauthenticatedReportAdapter: ReportAdapter = { getReport: unavailable };

export function reportFiltersFromSearchParams(
  params: URLSearchParams,
  fallback: { from: string; to: string },
): ReportFilters {
  const kind = params.get("kind");
  return {
    from: params.get("from") || fallback.from,
    to: params.get("to") || fallback.to,
    kind: kind === "income" || kind === "expense" ? kind : "all",
    categoryId: params.get("categoryId") || null,
  };
}

export function reportFiltersToSearchParams(filters: ReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.kind !== "all") params.set("kind", filters.kind);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  return params;
}

export function reportExportPath(filters: ReportFilters): string {
  const params = reportFiltersToSearchParams(filters);
  params.set("domain", "transactions");
  return `/app/data?${params.toString()}`;
}

export function createHttpReportAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): ReportAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";
  return {
    async getReport(workspaceId, filters) {
      const params = reportFiltersToSearchParams(filters);
      if (filters.asOf) params.set("asOf", filters.asOf);
      let response: Response;
      try {
        response = await request(
          `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/insights/reports?${params.toString()}`,
          { credentials: "include", headers: { Accept: "application/json" } },
        );
      } catch {
        throw new ReportAdapterError("Não foi possível conectar ao Casei.");
      }
      const payload = (await response.json().catch(() => null)) as
        | FinancialReport
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        const error =
          payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
        throw new ReportAdapterError(
          error?.message ?? "Não foi possível carregar os relatórios.",
          response.status,
        );
      }
      return payload as FinancialReport;
    },
  };
}

const fixtureMoney = (minor: string): ReportMoney => ({ currency: "BRL", minor });

export function createFixtureReportAdapter(): ReportAdapter {
  return {
    async getReport(_workspaceId, filters) {
      const monthly: ReportPeriod[] = [
        {
          month: filters.from.slice(0, 7),
          income: fixtureMoney("500000"),
          expense: fixtureMoney("185000"),
          net: fixtureMoney("315000"),
          transactionCount: 9,
        },
      ];
      return {
        asOf: filters.to,
        from: filters.from,
        to: filters.to,
        currency: "BRL",
        filters: { kind: filters.kind, categoryId: filters.categoryId },
        totals: {
          income: fixtureMoney("500000"),
          expense: fixtureMoney("185000"),
          net: fixtureMoney("315000"),
          transactionCount: 9,
        },
        monthly,
        categories: [
          {
            categoryId: null,
            categoryName: "Sem categoria",
            income: fixtureMoney("500000"),
            expense: fixtureMoney("0"),
            net: fixtureMoney("500000"),
            transactionCount: 2,
          },
          {
            categoryId: "fixture-market",
            categoryName: "Mercado",
            income: fixtureMoney("0"),
            expense: fixtureMoney("185000"),
            net: fixtureMoney("-185000"),
            transactionCount: 7,
          },
        ],
        reconciliation: {
          source: "published_ledger",
          transactionCount: 9,
          income: fixtureMoney("500000"),
          expense: fixtureMoney("185000"),
          export: {
            domain: "transactions",
            format: "csv",
            from: filters.from,
            to: filters.to,
            kind: filters.kind,
            categoryId: filters.categoryId,
          },
        },
      };
    },
  };
}

export function reportAdapterForEnvironment(options: { fixtures?: boolean } = {}): ReportAdapter {
  if (options.fixtures) return createFixtureReportAdapter();
  const origin = configuredApiOrigin();
  return origin ? createHttpReportAdapter({ baseUrl: origin }) : unauthenticatedReportAdapter;
}

export type SimulationEvent = {
  id: string;
  kind: "income" | "expense";
  amountMinor: string;
  occurredOn: string;
  categoryId: string | null;
  categoryName: string;
};

export type SimulationChange = {
  id: string;
  operation: "add" | "replace";
  eventId?: string;
  event: SimulationEvent;
};

function money(currency: string, minor: bigint): ReportMoney {
  return { currency, minor: minor.toString() };
}

function addToMoney(value: ReportMoney, delta: bigint): ReportMoney {
  return money(value.currency, BigInt(value.minor) + delta);
}

function applyEventDelta(
  target: FinancialReport,
  event: SimulationEvent,
  multiplier: bigint,
): void {
  const amount = BigInt(event.amountMinor) * multiplier;
  const income = event.kind === "income" ? amount : BigInt(0);
  const expense = event.kind === "expense" ? amount : BigInt(0);
  target.totals.income = addToMoney(target.totals.income, income);
  target.totals.expense = addToMoney(target.totals.expense, expense);
  target.totals.net = addToMoney(target.totals.net, income - expense);
  target.totals.transactionCount = Math.max(0, target.totals.transactionCount + Number(multiplier));
  const month = event.occurredOn.slice(0, 7);
  let period = target.monthly.find((item) => item.month === month);
  if (!period) {
    period = {
      month,
      income: money(target.currency, BigInt(0)),
      expense: money(target.currency, BigInt(0)),
      net: money(target.currency, BigInt(0)),
      transactionCount: 0,
    };
    target.monthly = [...target.monthly, period].sort((left, right) =>
      left.month.localeCompare(right.month),
    );
  }
  period.income = addToMoney(period.income, income);
  period.expense = addToMoney(period.expense, expense);
  period.net = addToMoney(period.net, income - expense);
  period.transactionCount = Math.max(0, period.transactionCount + Number(multiplier));
  let category = target.categories.find((item) => item.categoryId === event.categoryId);
  if (!category) {
    category = {
      categoryId: event.categoryId,
      categoryName: event.categoryName,
      income: money(target.currency, BigInt(0)),
      expense: money(target.currency, BigInt(0)),
      net: money(target.currency, BigInt(0)),
      transactionCount: 0,
    };
    target.categories = [...target.categories, category].sort((left, right) =>
      left.categoryName.localeCompare(right.categoryName),
    );
  }
  category.income = addToMoney(category.income, income);
  category.expense = addToMoney(category.expense, expense);
  category.net = addToMoney(category.net, income - expense);
  category.transactionCount = Math.max(0, category.transactionCount + Number(multiplier));
}

/** Applies only to a cloned report; the input response and event list are never mutated. */
export function applySimulationChanges(
  report: FinancialReport,
  events: readonly SimulationEvent[],
  changes: readonly SimulationChange[],
): FinancialReport {
  const next: FinancialReport = structuredClone(report);
  const eventById = new Map(events.map((event) => [event.id, event]));
  for (const change of changes) {
    if (change.operation === "replace") {
      const previous = change.eventId ? eventById.get(change.eventId) : undefined;
      if (!previous) continue;
      applyEventDelta(next, previous, -BigInt(1));
      applyEventDelta(next, change.event, BigInt(1));
      eventById.set(previous.id, change.event);
    } else {
      applyEventDelta(next, change.event, BigInt(1));
    }
  }
  next.reconciliation = {
    ...next.reconciliation,
    transactionCount: next.totals.transactionCount,
    income: next.totals.income,
    expense: next.totals.expense,
  };
  return next;
}

export function simulationEventFromTransaction(
  transaction: Pick<
    Transaction,
    "id" | "kind" | "amount" | "settledAmount" | "occurredOn" | "categoryId"
  >,
  categoryName = "Sem categoria",
): SimulationEvent | null {
  if (transaction.kind !== "income" && transaction.kind !== "expense") return null;
  return {
    id: transaction.id,
    kind: transaction.kind,
    amountMinor: transaction.settledAmount.minor,
    occurredOn: transaction.occurredOn,
    categoryId: transaction.categoryId,
    categoryName,
  };
}

export function simulationToPlannedTransaction(
  event: SimulationEvent,
  currency: string,
): CreateTransactionInput {
  return {
    kind: event.kind,
    amount: { currency, minor: event.amountMinor },
    occurredOn: event.occurredOn,
    dueOn: event.occurredOn,
    state: "planned",
    description: "Planejamento criado a partir de uma simulação",
    categoryId: event.categoryId,
    cardId: null,
  };
}
