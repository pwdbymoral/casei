import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Goal } from "@/lib/goals";
import { GoalCard } from "./goal-card";

const goal: Goal = {
  id: "goal-1",
  workspaceId: "workspace-1",
  name: "Reserva de emergência",
  target: { currency: "BRL", minor: "100000" },
  reserved: { currency: "BRL", minor: "25000" },
  uncovered: { currency: "BRL", minor: "0" },
  remaining: { currency: "BRL", minor: "75000" },
  contributionPeriodsRemaining: 5,
  requiredContribution: { currency: "BRL", minor: "15000" },
  deadline: "2027-01-31",
  priority: "high",
  status: "active",
  note: null,
  version: 2,
};

function renderGoalCard(value: Goal = goal) {
  return renderToStaticMarkup(
    <GoalCard
      goal={value}
      currency="BRL"
      writable
      busy={false}
      onAction={vi.fn()}
      onHistory={vi.fn()}
      onSimulation={vi.fn()}
    />,
  );
}

describe("GoalCard", () => {
  it("exposes progress and server-provided pace as accessible content", () => {
    const html = renderGoalCard();

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("Ritmo sugerido");
    expect(html).toContain("por mês");
    expect(html).toContain("Simular contribuição");
  });

  it("keeps an uncovered reserve visibly distinct from available money", () => {
    const html = renderGoalCard({
      ...goal,
      uncovered: { currency: "BRL", minor: "10000" },
    });

    expect(html).toContain("Reserva sem cobertura");
    expect(html).toContain("excedem o saldo disponível");
  });

  it("shows guidance instead of inventing a pace when the deadline is missing", () => {
    const html = renderGoalCard({
      ...goal,
      deadline: null,
      contributionPeriodsRemaining: null,
      requiredContribution: null,
    });

    expect(html).toContain("Defina um prazo para ver o ritmo sugerido");
  });
});
