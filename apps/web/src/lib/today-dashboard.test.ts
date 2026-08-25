import { describe, expect, it } from "vitest";

import { buildTodayCommitments, goalsRequiringAttention } from "./today-dashboard";

const money = (minor: string) => ({ currency: "BRL", minor });

describe("today dashboard transformations", () => {
  it("prioritizes overdue commitments and includes only the next seven days", () => {
    const transactions = [
      {
        id: "overdue",
        kind: "expense" as const,
        state: "partially_settled" as const,
        amount: money("10000"),
        settledAmount: money("2500"),
        occurredOn: "2026-08-01",
        dueOn: "2026-08-23",
        description: "Aluguel",
      },
      {
        id: "upcoming",
        kind: "expense" as const,
        state: "planned" as const,
        amount: money("2500"),
        settledAmount: money("0"),
        occurredOn: "2026-08-24",
        dueOn: "2026-08-29",
        description: "Internet",
      },
      {
        id: "later",
        kind: "expense" as const,
        state: "planned" as const,
        amount: money("2500"),
        settledAmount: money("0"),
        occurredOn: "2026-08-24",
        dueOn: "2026-09-01",
        description: "Fora da janela",
      },
    ];
    const result = buildTodayCommitments({
      transactions,
      statements: [],
      asOf: "2026-08-24",
      currency: "BRL",
    });

    expect(result).toEqual([
      expect.objectContaining({ id: "overdue", bucket: "overdue", amountMinor: "7500" }),
      expect.objectContaining({ id: "upcoming", bucket: "upcoming" }),
    ]);
  });

  it("shows open card invoices without duplicating card purchases", () => {
    const result = buildTodayCommitments({
      transactions: [],
      statements: [
        {
          id: "statement-1",
          dueOn: "2026-08-30",
          state: "open",
          openAmount: money("5000"),
        },
      ],
      asOf: "2026-08-24",
      currency: "BRL",
    });
    expect(result).toEqual([
      expect.objectContaining({ id: "statement-statement-1", amountMinor: "5000" }),
    ]);
  });

  it("only surfaces active goals with a near deadline or uncovered reservation", () => {
    const goal = (overrides: Record<string, unknown> = {}) => ({
      id: "goal-1",
      name: "Reserva",
      target: money("10000"),
      reserved: money("5000"),
      uncovered: money("0"),
      remaining: money("5000"),
      contributionPeriodsRemaining: 2,
      requiredContribution: money("2500"),
      deadline: "2026-09-10",
      priority: "normal" as const,
      status: "active" as const,
      ...overrides,
    });
    expect(
      goalsRequiringAttention([goal(), goal({ id: "safe", deadline: "2027-01-01" })], "2026-08-24"),
    ).toHaveLength(1);
    expect(
      goalsRequiringAttention(
        [goal({ id: "uncovered", deadline: "2027-01-01", uncovered: money("100") })],
        "2026-08-24",
      ),
    ).toHaveLength(1);
  });
});
