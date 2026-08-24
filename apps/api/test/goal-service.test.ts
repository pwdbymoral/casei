import { describe, expect, it, vi } from "vitest";
import { GoalService } from "../src/goal-service.js";
import { decodeCursor } from "../src/http/cursor.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const cursorSecret = "test-secret-that-is-long-enough";
const scope = {
  workspaceId,
  actorId: "user-1",
  correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  role: "member" as const,
};

function goalRow(id: string, createdAt: string) {
  return {
    id,
    workspace_id: workspaceId,
    name: id === "0190f3c8-2a10-7abc-8def-1234567890ac" ? "Viagem" : "Reserva",
    target_minor: "1000",
    currency_code: "BRL",
    deadline: null,
    priority: "normal" as const,
    status: "active" as const,
    note: null,
    version: 0,
    created_at: new Date(createdAt),
    allocated_minor: "0",
    released_minor: "0",
    spent_minor: "0",
  };
}

describe("GoalService", () => {
  it("paginates goals with a signed cursor that resumes after creation time and id", async () => {
    const firstGoal = goalRow("0190f3c8-2a10-7abc-8def-1234567890ac", "2026-08-23T12:01:00.000Z");
    const secondGoal = goalRow("0190f3c8-2a10-7abc-8def-1234567890ad", "2026-08-23T12:00:00.000Z");
    let rows = [firstGoal, secondGoal];
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT g.id")) return { rows };
        if (sql.includes("SUM(le.amount_minor)")) return { rows: [{ balance_minor: "5000" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GoalService({ connect: vi.fn(async () => client) } as never, {
      cursorSecret,
    });

    const first = await service.listGoals(scope, { limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.id).toBe(firstGoal.id);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(decodeCursor(first.nextCursor as string, cursorSecret)).toEqual({
      ordering: "created_at,id",
      position: ["2026-08-23T12:01:00.000Z", firstGoal.id],
    });

    rows = [secondGoal];
    const second = await service.listGoals(scope, {
      limit: 1,
      cursor: first.nextCursor as string,
    });

    expect(second.items[0]?.id).toBe(secondGoal.id);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const resumedQuery = queries.filter((sql) => sql.includes("SELECT g.id")).at(-1);
    expect(resumedQuery).toContain("g.created_at <");
    expect(resumedQuery).toContain("g.id <");
  });

  it("paginates goal movements with the same signed cursor contract", async () => {
    const goalId = "0190f3c8-2a10-7abc-8def-1234567890ac";
    const firstMovement = {
      id: "0190f3c8-2a10-7abc-8def-1234567890ad",
      goal_id: goalId,
      kind: "allocate" as const,
      amount_minor: "60",
      currency_code: "BRL",
      transaction_id: null,
      occurred_on: "2026-08-23",
      note: null,
      created_at: new Date("2026-08-23T12:01:00.000Z"),
    };
    const secondMovement = { ...firstMovement, id: "0190f3c8-2a10-7abc-8def-1234567890ae" };
    let rows = [firstMovement, secondMovement];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM goal WHERE"))
          return { rows: [goalRow(goalId, "2026-08-23T12:00:00.000Z")] };
        if (sql.includes("FROM goal_reservation_movement")) return { rows };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const service = new GoalService({ connect: vi.fn(async () => client) } as never, {
      cursorSecret,
    });

    const first = await service.listMovements(scope, goalId, { limit: 1 });
    expect(first.items[0]?.id).toBe(firstMovement.id);
    expect(first.nextCursor).toBeTruthy();
    expect(decodeCursor(first.nextCursor as string, cursorSecret)).toEqual({
      ordering: "occurred_on,created_at,id",
      position: ["2026-08-23", "2026-08-23T12:01:00.000Z", firstMovement.id],
    });

    rows = [secondMovement];
    const second = await service.listMovements(scope, goalId, {
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(second.items[0]?.id).toBe(secondMovement.id);
    expect(second.nextCursor).toBeNull();
  });
});
