import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confidenceLabel,
  createHttpInsightAdapter,
  type FinancialReadModel,
  insightReasonLabel,
} from "./insights";

const financial: FinancialReadModel = {
  asOf: "2026-08-24",
  from: "2026-08-24",
  to: "2026-08-31",
  currency: "BRL",
  balance: { currency: "BRL", minor: "10000" },
  result: {
    income: { currency: "BRL", minor: "0" },
    expense: { currency: "BRL", minor: "0" },
    transfer: { currency: "BRL", minor: "0" },
    adjustment: { currency: "BRL", minor: "0" },
  },
  commitments: {
    plannedIncome: { currency: "BRL", minor: "0" },
    plannedOutflow: { currency: "BRL", minor: "0" },
    overdueOutflow: { currency: "BRL", minor: "0" },
    walletOutflow: { currency: "BRL", minor: "0" },
    cardBills: { currency: "BRL", minor: "0" },
    loanReceivable: { currency: "BRL", minor: "0" },
    loanPayable: { currency: "BRL", minor: "0" },
    count: 0,
  },
  reservations: {
    reserved: { currency: "BRL", minor: "0" },
    covered: { currency: "BRL", minor: "0" },
    uncovered: { currency: "BRL", minor: "0" },
  },
  stock: { missingCount: 0, lowCount: 0 },
  confidence: { level: "high", reasons: ["saldo_conferido_recentemente"] },
};

afterEach(() => vi.restoreAllMocks());

describe("insight HTTP adapter", () => {
  it("encodes the workspace and query parameters for both read models", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify(
          String(input).includes("safe-to-spend")
            ? { safe: null, gross: null, available: false, confidence: financial.confidence }
            : financial,
        ),
        { status: 200 },
      );
    });
    const adapter = createHttpInsightAdapter({ baseUrl: "http://api.test", fetch: fetchMock });

    await adapter.getFinancial("space/1", { asOf: "2026-08-24" });
    await adapter.getSafeToSpend("space/1", { asOf: "2026-08-24", horizonDays: 30 });

    expect(requests).toEqual([
      "http://api.test/v1/workspaces/space%2F1/insights/financial?asOf=2026-08-24",
      "http://api.test/v1/workspaces/space%2F1/insights/safe-to-spend?asOf=2026-08-24&horizonDays=30",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("maps network and permission failures to safe user-facing adapter errors", async () => {
    const adapter = createHttpInsightAdapter({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Sem acesso" } }), { status: 403 }),
      ),
    });
    await expect(adapter.getFinancial("space-1")).rejects.toMatchObject({
      message: "Sem acesso",
      status: 403,
    });

    const offline = createHttpInsightAdapter({
      fetch: vi.fn(async () => Promise.reject(new Error("network"))),
    });
    await expect(offline.getSafeToSpend("space-1")).rejects.toMatchObject({
      message: "Não foi possível conectar ao Casei.",
    });
  });
});

describe("insight copy", () => {
  it("keeps confidence and reason copy understandable in Portuguese", () => {
    expect(confidenceLabel("high")).toBe("confiança alta");
    expect(confidenceLabel("medium")).toBe("confiança média");
    expect(confidenceLabel("low")).toBe("confiança baixa");
    expect(insightReasonLabel("saldo_sem_evidencia_de_abertura_ou_conferencia")).toBe(
      "Confira seu saldo inicial",
    );
  });
});
