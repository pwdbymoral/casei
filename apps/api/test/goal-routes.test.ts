import { IdempotencyConflictError } from "@casei/database";
import { DomainError } from "@casei/domain";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { configureFinanceRoutes, financeErrorToHttp } from "../src/finance-routes.js";
import type { FinanceService } from "../src/finance-service.js";
import type { GoalService } from "../src/goal-service.js";
import { createActorMiddleware, createWorkspaceScopeMiddleware } from "../src/http/middleware.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const goalId = "0190f3c8-2a10-7abc-8def-1234567890ac";

describe("goal HTTP contract", () => {
  it("maps domain validation and idempotency failures to stable API errors", () => {
    expect(
      financeErrorToHttp(new DomainError("validation_failed", "cobertura insuficiente")),
    ).toMatchObject({
      status: 422,
      code: "validation_failed",
    });
    expect(financeErrorToHttp(new IdempotencyConflictError())).toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    });
  });

  it("forwards idempotency, version and explicit coverage/spend commands", async () => {
    const received: Record<string, unknown> = {};
    const goal = {
      id: goalId,
      workspaceId,
      name: "Reserva",
      target: { currency: "BRL", minor: "1000" },
      reserved: { currency: "BRL", minor: "500" },
      uncovered: { currency: "BRL", minor: "0" },
      deadline: null,
      priority: "normal",
      status: "active",
      note: null,
      version: 0,
    } as const;
    const fakeGoalService = {
      createGoal: async (_scope: unknown, input: unknown, key: string) => {
        received.create = { input, key };
        return { goal, replayed: false };
      },
      listGoals: async () => ({ items: [goal], nextCursor: null, hasMore: false }),
      getGoal: async () => goal,
      listMovements: async () => ({ items: [], nextCursor: null, hasMore: false }),
      updateGoal: async () => ({ goal: { ...goal, version: 1 }, replayed: false }),
      allocateGoal: async (
        _scope: unknown,
        id: string,
        input: unknown,
        key: string,
        version: number,
      ) => {
        received.allocate = { id, input, key, version };
        return { goal: { ...goal, version: 1 }, replayed: false };
      },
      releaseGoal: async () => ({ goal: { ...goal, version: 1 }, replayed: false }),
      spendGoal: async (
        _scope: unknown,
        id: string,
        input: unknown,
        key: string,
        version: number,
      ) => {
        received.spend = { id, input, key, version };
        return {
          goal: { ...goal, reserved: { currency: "BRL", minor: "0" }, version: 1 },
          transactionId: "0190f3c8-2a10-7abc-8def-1234567890ad",
          replayed: false,
        };
      },
      transitionGoal: async () => ({ goal: { ...goal, version: 1 }, replayed: false }),
    } as unknown as GoalService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" as const }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: {} as FinanceService,
        goalService: fakeGoalService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );

    const create = await app.request(`http://localhost/v1/workspaces/${workspaceId}/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "goal-route-create-001" },
      body: JSON.stringify({ name: "Reserva", target: { currency: "BRL", minor: "1000" } }),
    });
    expect(create.status).toBe(201);

    const allocate = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/goals/${goalId}/allocate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "goal-route-allocate-001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({ amount: { currency: "BRL", minor: "500" }, allowUncovered: true }),
      },
    );
    expect(allocate.status).toBe(200);

    const spend = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/goals/${goalId}/spend`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "goal-route-spend-001",
          "if-match": '"v0"',
        },
        body: JSON.stringify({ amount: { currency: "BRL", minor: "500" }, description: "Compra" }),
      },
    );
    expect(spend.status).toBe(201);
    expect(spend.headers.get("etag")).toBe('"v1"');
    expect(received.create).toMatchObject({ key: "goal-route-create-001" });
    expect(received.allocate).toMatchObject({ id: goalId, version: 0 });
    expect(received.spend).toMatchObject({ id: goalId, version: 0 });
  });

  it("rejects a write without If-Match before calling the service", async () => {
    let called = false;
    const fakeGoalService = {
      createGoal: async () => ({ goal: {}, replayed: false }),
      allocateGoal: async () => {
        called = true;
        return { goal: {}, replayed: false };
      },
    } as unknown as GoalService;
    const scopeMiddleware = createActorMiddleware(async () => ({ userId: "user-1" }));
    const membershipMiddleware = createWorkspaceScopeMiddleware(
      async ({ actor, workspaceId: id }) => ({ actor, workspaceId: id, role: "member" as const }),
    );
    const app = createApp((v1) =>
      configureFinanceRoutes(v1, {
        service: {} as FinanceService,
        goalService: fakeGoalService,
        scopeMiddleware: async (context, next) => {
          await scopeMiddleware(context, async () => {
            await membershipMiddleware(context, next);
          });
        },
      }),
    );
    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/goals/${goalId}/allocate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "goal-route-missing-version",
        },
        body: JSON.stringify({ amount: { currency: "BRL", minor: "1" } }),
      },
    );
    expect(response.status).toBe(428);
    expect(called).toBe(false);
  });
});
