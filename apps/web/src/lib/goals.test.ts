import { describe, expect, it, vi } from "vitest";

import {
  createFixtureGoalsAdapter,
  createHttpGoalsAdapter,
  type Goal,
  type GoalMovement,
  goalProgressPercent,
} from "./goals";

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

describe("goals adapter", () => {
  it("calculates progress without using floating point money", () => {
    expect(goalProgressPercent(goal)).toBe(25);
    expect(goalProgressPercent({ ...goal, target: { currency: "BRL", minor: "0" } })).toBe(0);
    expect(goalProgressPercent({ ...goal, reserved: { currency: "BRL", minor: "120000" } })).toBe(
      100,
    );
  });

  it("uses the published goal routes and concurrency headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (new URL(url).pathname.endsWith("/goals"))
        return new Response(
          JSON.stringify({ items: [goal], page: { nextCursor: null, hasMore: false } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      if (url.endsWith("/allocate"))
        return new Response(JSON.stringify({ goal, replayed: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      throw new Error(`unexpected request ${url} ${(init?.method ?? "GET").toString()}`);
    });
    const adapter = createHttpGoalsAdapter({ baseUrl: "https://api.example", fetch });

    await expect(
      adapter.listGoals("workspace-1", { cursor: "cursor-1", limit: 100 }),
    ).resolves.toEqual({
      items: [goal],
      nextCursor: null,
      hasMore: false,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("?cursor=cursor-1&limit=100");
    await adapter.allocate("workspace-1", goal, { amount: { currency: "BRL", minor: "1000" } });

    const [, request] = fetch.mock.calls[1] ?? [];
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("If-Match")).toBe('"v2"');
    expect(new Headers(request?.headers).get("Idempotency-Key")).toMatch(/^goal-/);
  });

  it("preserves movement kind and amount in fixture-compatible types", () => {
    const movement: GoalMovement = {
      id: "movement-1",
      goalId: goal.id,
      kind: "allocate",
      amount: { currency: "BRL", minor: "1000" },
      transactionId: null,
      occurredOn: "2026-08-24",
      note: null,
    };
    expect(movement.kind).toBe("allocate");
    expect(BigInt(movement.amount.minor)).toBe(BigInt(1000));
  });

  it("keeps fixture reserve arithmetic consistent for spending and new workspaces", async () => {
    const adapter = createFixtureGoalsAdapter();
    const created = await adapter.createGoal("workspace-new", {
      name: "Viagem",
      target: { currency: "BRL", minor: "10000" },
    });
    const allocated = await adapter.allocate("workspace-new", created, {
      amount: { currency: "BRL", minor: "4000" },
    });
    const spent = await adapter.spend("workspace-new", allocated.goal, {
      amount: { currency: "BRL", minor: "1500" },
    });

    expect(spent.goal.reserved.minor).toBe("2500");
    expect(spent.goal.remaining.minor).toBe("7500");
    await expect(
      adapter.spend("workspace-new", spent.goal, {
        amount: { currency: "BRL", minor: "3000" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const movements = await adapter.listMovements("workspace-new", created.id);
    expect(movements.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "spend", transactionId: expect.any(String) }),
      ]),
    );
  });

  it("requires explicit fixture confirmation for an uncovered allocation", async () => {
    const adapter = createFixtureGoalsAdapter();
    const created = await adapter.createGoal("workspace-uncovered", {
      name: "Entrada",
      target: { currency: "BRL", minor: "200000" },
    });
    await expect(
      adapter.allocate("workspace-uncovered", created, {
        amount: { currency: "BRL", minor: "110000" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const mutation = await adapter.allocate("workspace-uncovered", created, {
      amount: { currency: "BRL", minor: "110000" },
      allowUncovered: true,
    });
    expect(mutation.goal.uncovered.minor).toBe("10000");
  });
});
