import { describe, expect, it, vi } from "vitest";

import { createHttpGoalsAdapter, type Goal, type GoalMovement, goalProgressPercent } from "./goals";

const goal: Goal = {
  id: "goal-1",
  workspaceId: "workspace-1",
  name: "Reserva de emergência",
  target: { currency: "BRL", minor: "100000" },
  reserved: { currency: "BRL", minor: "25000" },
  uncovered: { currency: "BRL", minor: "0" },
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
      if (url.endsWith("/goals"))
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

    await expect(adapter.listGoals("workspace-1")).resolves.toEqual({
      items: [goal],
      nextCursor: null,
      hasMore: false,
    });
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
});
