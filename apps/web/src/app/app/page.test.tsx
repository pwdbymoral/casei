import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Goal } from "@/lib/goals";
import type { FinancialReadModel, SafeToSpendView } from "@/lib/insights";
import type { StockShoppingItem } from "@/lib/stock";
import TodayPage from "./page";

const { DashboardContent } = TodayPage;
type DashboardData = Parameters<typeof DashboardContent>[0]["data"];

const money = (minor: string) => ({ currency: "BRL", minor });
const financial: FinancialReadModel = {
  asOf: "2026-08-24",
  from: "2026-08-24",
  to: "2026-08-31",
  currency: "BRL",
  balance: money("120000"),
  result: { income: money("0"), expense: money("0"), transfer: money("0"), adjustment: money("0") },
  commitments: {
    plannedIncome: money("0"),
    plannedOutflow: money("0"),
    overdueOutflow: money("0"),
    walletOutflow: money("0"),
    cardBills: money("0"),
    loanReceivable: money("0"),
    loanPayable: money("0"),
    count: 0,
  },
  reservations: { reserved: money("0"), covered: money("0"), uncovered: money("0") },
  stock: { missingCount: 0, lowCount: 0 },
  confidence: { level: "medium", reasons: ["saldo_sem_conferencia_recente"] },
};
const safeToSpend: SafeToSpendView = {
  asOf: financial.asOf,
  from: financial.asOf,
  to: "2026-09-23",
  horizonDays: 30,
  currency: "BRL",
  available: true,
  safe: money("0"),
  gross: money("-5000"),
  confidence: { level: "low", reasons: ["saldo_sem_evidencia_de_abertura_ou_conferencia"] },
  breakdown: {
    balance: money("120000"),
    plannedIncome: money("0"),
    plannedOutflow: money("125000"),
    walletOutflow: money("0"),
    cardBills: money("0"),
    loanReceivable: money("0"),
    loanPayable: money("0"),
    coveredReservations: money("0"),
    reserved: money("0"),
    uncoveredReservations: money("0"),
    safetyMargin: money("0"),
  },
};
const goal: Goal = {
  id: "goal-1",
  workspaceId: "workspace-1",
  name: "Viagem",
  target: money("100000"),
  reserved: money("10000"),
  uncovered: money("0"),
  remaining: money("90000"),
  contributionPeriodsRemaining: 2,
  requiredContribution: money("45000"),
  deadline: "2026-09-01",
  priority: "high",
  status: "active",
  note: null,
  version: 1,
};
const shoppingItem: StockShoppingItem = {
  id: "shopping-1",
  workspaceId: "workspace-1",
  name: "Café",
  quantity: "1",
  unit: "unit",
  unitLabel: null,
  source: "free",
  productId: null,
  note: null,
  purchased: false,
  purchasedAt: null,
  expenseTransactionId: null,
  lastChangedBy: null,
  version: 1,
};

function renderDashboard(overrides: Partial<DashboardData> = {}, hidden = false) {
  return renderToStaticMarkup(
    <DashboardContent
      data={{
        workspaceId: "workspace-1",
        financial,
        safeToSpend,
        commitments: [],
        goals: [goal],
        shoppingItems: [shoppingItem],
        sectionErrors: {},
        ...overrides,
      }}
      hidden={hidden}
      onToggleHidden={vi.fn()}
      onRetry={vi.fn()}
      loadError={null}
    />,
  );
}

describe("Today dashboard component", () => {
  it("renders the negative projection as a deficit with the safe amount and review link", () => {
    const html = renderDashboard();
    expect(html).toContain("R$ 0,00");
    expect(html).toContain("Déficit previsto");
    expect(html).toContain("-R$ 50,00");
    expect(html).toContain("Revisar déficit");
    expect(html).toContain('href="/app/finances#safe-to-spend"');
  });

  it("keeps the deficit explanation hidden visually but accessible", () => {
    const html = renderDashboard({}, true);
    expect(html).toContain("••••••");
    expect(html).toContain("-R$ 50,00");
    expect(html).toContain('aria-label="Mostrar valores"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders actionable empty and partial states", () => {
    const html = renderDashboard({
      goals: [],
      shoppingItems: [],
      sectionErrors: { commitments: "Faturas: falha de rede" },
    });
    expect(html).toContain("Os compromissos não estão disponíveis agora.");
    expect(html).toContain("Nenhuma meta precisa de ação agora.");
    expect(html).toContain("Nenhum item marcado como faltando.");
  });
});
