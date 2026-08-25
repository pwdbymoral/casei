import { configuredApiOrigin } from "./api-origin";

export type InsightMoney = { currency: string; minor: string };

export type InsightConfidence = {
  level: "high" | "medium" | "low";
  reasons: string[];
};

export type FinancialReadModel = {
  asOf: string;
  from: string;
  to: string;
  currency: string;
  balance: InsightMoney;
  result: {
    income: InsightMoney;
    expense: InsightMoney;
    transfer: InsightMoney;
    adjustment: InsightMoney;
  };
  commitments: {
    plannedIncome: InsightMoney;
    plannedOutflow: InsightMoney;
    overdueOutflow: InsightMoney;
    walletOutflow: InsightMoney;
    cardBills: InsightMoney;
    loanReceivable: InsightMoney;
    loanPayable: InsightMoney;
    count: number;
  };
  reservations: {
    reserved: InsightMoney;
    covered: InsightMoney;
    uncovered: InsightMoney;
  };
  stock: { missingCount: number; lowCount: number };
  confidence: InsightConfidence;
};

export type SafeToSpendView = {
  asOf: string;
  from: string;
  to: string;
  horizonDays: number;
  currency: string;
  available: boolean;
  safe: InsightMoney | null;
  gross: InsightMoney | null;
  confidence: InsightConfidence;
  breakdown: {
    balance: InsightMoney;
    plannedIncome: InsightMoney;
    plannedOutflow: InsightMoney;
    walletOutflow: InsightMoney;
    cardBills: InsightMoney;
    loanReceivable: InsightMoney;
    loanPayable: InsightMoney;
    coveredReservations: InsightMoney;
    reserved: InsightMoney;
    uncoveredReservations: InsightMoney;
    safetyMargin: InsightMoney;
  };
};

export type InsightAdapter = {
  getFinancial(workspaceId: string, input?: { asOf?: string }): Promise<FinancialReadModel>;
  getSafeToSpend(
    workspaceId: string,
    input?: { asOf?: string; horizonDays?: number },
  ): Promise<SafeToSpendView>;
};

export class InsightAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "InsightAdapterError";
  }
}

const unavailable = async (..._args: never[]): Promise<never> => {
  throw new InsightAdapterError(
    "Seus insights não estão disponíveis. Entre novamente para continuar.",
    401,
  );
};

export const unauthenticatedInsightAdapter: InsightAdapter = {
  getFinancial: unavailable,
  getSafeToSpend: unavailable,
};

export function createHttpInsightAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): InsightAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  async function call<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await request(`${baseUrl}/v1${path}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new InsightAdapterError("Não foi possível conectar ao Casei.");
    }
    const payload = (await response.json().catch(() => null)) as
      | T
      | { error?: { message?: string } }
      | null;
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      throw new InsightAdapterError(
        error?.message ?? "Não foi possível carregar os insights.",
        response.status,
      );
    }
    return payload as T;
  }

  return {
    getFinancial(workspaceId, input = {}) {
      const query = input.asOf ? `?asOf=${encodeURIComponent(input.asOf)}` : "";
      return call<FinancialReadModel>(
        `/workspaces/${encodeURIComponent(workspaceId)}/insights/financial${query}`,
      );
    },
    getSafeToSpend(workspaceId, input = {}) {
      const params = new URLSearchParams();
      if (input.asOf) params.set("asOf", input.asOf);
      if (input.horizonDays !== undefined) params.set("horizonDays", String(input.horizonDays));
      const query = params.toString() ? `?${params.toString()}` : "";
      return call<SafeToSpendView>(
        `/workspaces/${encodeURIComponent(workspaceId)}/insights/safe-to-spend${query}`,
      );
    },
  };
}

const fixtureMoney = (minor: string): InsightMoney => ({ currency: "BRL", minor });

/** Fixture data is deliberately isolated here; production never fabricates insight values. */
export function createFixtureInsightAdapter(): InsightAdapter {
  const financial: FinancialReadModel = {
    asOf: "2026-08-24",
    from: "2026-08-24",
    to: "2026-08-31",
    currency: "BRL",
    balance: fixtureMoney("284000"),
    result: {
      income: fixtureMoney("0"),
      expense: fixtureMoney("0"),
      transfer: fixtureMoney("0"),
      adjustment: fixtureMoney("0"),
    },
    commitments: {
      plannedIncome: fixtureMoney("0"),
      plannedOutflow: fixtureMoney("0"),
      overdueOutflow: fixtureMoney("0"),
      walletOutflow: fixtureMoney("0"),
      cardBills: fixtureMoney("0"),
      loanReceivable: fixtureMoney("0"),
      loanPayable: fixtureMoney("0"),
      count: 0,
    },
    reservations: {
      reserved: fixtureMoney("0"),
      covered: fixtureMoney("0"),
      uncovered: fixtureMoney("0"),
    },
    stock: { missingCount: 0, lowCount: 0 },
    confidence: { level: "medium", reasons: ["fixture_de_desenvolvimento"] },
  };
  return {
    async getFinancial() {
      return financial;
    },
    async getSafeToSpend() {
      return {
        asOf: financial.asOf,
        from: financial.asOf,
        to: "2026-09-23",
        horizonDays: 30,
        currency: "BRL",
        available: true,
        safe: fixtureMoney("42000"),
        gross: fixtureMoney("42000"),
        confidence: financial.confidence,
        breakdown: {
          balance: fixtureMoney("284000"),
          plannedIncome: fixtureMoney("0"),
          plannedOutflow: fixtureMoney("0"),
          walletOutflow: fixtureMoney("0"),
          cardBills: fixtureMoney("0"),
          loanReceivable: fixtureMoney("0"),
          loanPayable: fixtureMoney("0"),
          coveredReservations: fixtureMoney("0"),
          reserved: fixtureMoney("0"),
          uncoveredReservations: fixtureMoney("0"),
          safetyMargin: fixtureMoney("0"),
        },
      };
    },
  };
}

export function insightAdapterForEnvironment(options: { fixtures?: boolean } = {}): InsightAdapter {
  if (options.fixtures) return createFixtureInsightAdapter();
  const origin = configuredApiOrigin();
  return origin ? createHttpInsightAdapter({ baseUrl: origin }) : unauthenticatedInsightAdapter;
}

export function confidenceLabel(level: InsightConfidence["level"]): string {
  if (level === "high") return "confiança alta";
  if (level === "low") return "confiança baixa";
  return "confiança média";
}

export function insightReasonLabel(reason: string): string {
  if (reason === "saldo_sem_evidencia_de_abertura_ou_conferencia")
    return "Confira seu saldo inicial";
  if (reason === "saldo_sem_conferencia_recente") return "Confira o saldo nos últimos 30 dias";
  if (reason === "recorrencia_variavel_sem_estimativa") return "Há recorrências sem valor estimado";
  if (reason === "fixture_de_desenvolvimento") return "Dados de demonstração";
  return reason.replaceAll("_", " ");
}
