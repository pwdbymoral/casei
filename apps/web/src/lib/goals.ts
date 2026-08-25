import { configuredApiOrigin } from "./api-origin";
import type { WorkspaceRole } from "./workspaces";

export type GoalMoney = { currency: string; minor: string };
export type GoalStatus = "active" | "completed" | "paused" | "canceled";
export type GoalPriority = "low" | "normal" | "high";

export type Goal = {
  id: string;
  workspaceId: string;
  name: string;
  target: GoalMoney;
  reserved: GoalMoney;
  uncovered: GoalMoney;
  remaining: GoalMoney;
  contributionPeriodsRemaining: number | null;
  requiredContribution: GoalMoney | null;
  deadline: string | null;
  priority: GoalPriority;
  status: GoalStatus;
  note: string | null;
  version: number;
};

export type GoalMovement = {
  id: string;
  goalId: string;
  kind: "allocate" | "release" | "spend";
  amount: GoalMoney;
  transactionId: string | null;
  occurredOn: string;
  note: string | null;
};

export type GoalPage = {
  items: Goal[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type GoalMovementPage = {
  items: GoalMovement[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type CreateGoalInput = {
  name: string;
  target: GoalMoney;
  deadline?: string | null;
  priority?: GoalPriority;
  note?: string | null;
};

export type GoalAmountInput = {
  amount: GoalMoney;
  occurredOn?: string;
  note?: string | null;
  allowUncovered?: boolean;
};

export type GoalMutation = { goal: Goal; replayed: boolean; transactionId?: string };

export type GoalPageQuery = { cursor?: string | null; limit?: number };

export type GoalsAdapter = {
  listGoals(workspaceId: string, query?: GoalPageQuery): Promise<GoalPage>;
  listMovements(
    workspaceId: string,
    goalId: string,
    query?: GoalPageQuery,
  ): Promise<GoalMovementPage>;
  createGoal(workspaceId: string, input: CreateGoalInput): Promise<Goal>;
  updateGoal(workspaceId: string, goal: Goal, input: Partial<CreateGoalInput>): Promise<Goal>;
  allocate(workspaceId: string, goal: Goal, input: GoalAmountInput): Promise<GoalMutation>;
  release(
    workspaceId: string,
    goal: Goal,
    input: Omit<GoalAmountInput, "allowUncovered">,
  ): Promise<GoalMutation>;
  spend(
    workspaceId: string,
    goal: Goal,
    input: GoalAmountInput & { description?: string; categoryId?: string | null },
  ): Promise<GoalMutation>;
  transition(
    workspaceId: string,
    goal: Goal,
    action: "pause" | "resume" | "complete" | "cancel",
  ): Promise<GoalMutation>;
};

export class GoalsAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "GoalsAdapterError";
  }
}

const unavailable = async (..._args: never[]): Promise<never> => {
  throw new GoalsAdapterError(
    "Suas metas não estão disponíveis. Entre novamente para continuar.",
    401,
  );
};

export const unauthenticatedGoalsAdapter: GoalsAdapter = {
  listGoals: unavailable,
  listMovements: unavailable,
  createGoal: unavailable,
  updateGoal: unavailable,
  allocate: unavailable,
  release: unavailable,
  spend: unavailable,
  transition: unavailable,
};

type JsonPage<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };

export function goalProgressPercent(goal: Pick<Goal, "target" | "reserved">): number {
  const target = BigInt(goal.target.minor);
  if (target <= BigInt(0)) return 0;
  const reserved = BigInt(goal.reserved.minor);
  if (reserved <= BigInt(0)) return 0;
  const bounded = reserved > target ? target : reserved;
  return Number((bounded * BigInt(100)) / target);
}

export type GoalPace = {
  status: "complete" | "no_deadline" | "overdue" | "on_track" | "unavailable";
  periods: number | null;
  monthlyMinor: string | null;
};

/**
 * Converts the API's deterministic planning fields into a small presentation model.
 * The API remains the source of truth for the number of periods and monthly amount.
 */
export function goalPace(
  goal: Pick<Goal, "remaining" | "contributionPeriodsRemaining" | "requiredContribution">,
): GoalPace {
  if (BigInt(goal.remaining.minor) <= BigInt(0)) {
    return { status: "complete", periods: goal.contributionPeriodsRemaining, monthlyMinor: null };
  }
  if (goal.contributionPeriodsRemaining === null) {
    return { status: "no_deadline", periods: null, monthlyMinor: null };
  }
  if (goal.contributionPeriodsRemaining === 0) {
    return { status: "overdue", periods: 0, monthlyMinor: null };
  }
  if (!goal.requiredContribution) {
    return {
      status: "unavailable",
      periods: goal.contributionPeriodsRemaining,
      monthlyMinor: null,
    };
  }
  return {
    status: "on_track",
    periods: goal.contributionPeriodsRemaining,
    monthlyMinor: goal.requiredContribution.minor,
  };
}

export type GoalContributionSimulation = {
  periodsToTarget: bigint | null;
  reachesByDeadline: boolean | null;
  deadlinePeriods: number | null;
};

/** Calculates a local, non-persistent contribution scenario in minor units. */
export function simulateGoalContribution(
  goal: Pick<Goal, "remaining" | "contributionPeriodsRemaining">,
  contributionMinor: string,
): GoalContributionSimulation {
  const contribution = BigInt(contributionMinor || "0");
  const remaining = BigInt(goal.remaining.minor);
  if (remaining <= BigInt(0)) {
    return {
      periodsToTarget: BigInt(0),
      reachesByDeadline:
        goal.contributionPeriodsRemaining === null ? null : 0 <= goal.contributionPeriodsRemaining,
      deadlinePeriods: goal.contributionPeriodsRemaining,
    };
  }
  if (contribution <= BigInt(0)) {
    return {
      periodsToTarget: null,
      reachesByDeadline: null,
      deadlinePeriods: goal.contributionPeriodsRemaining,
    };
  }
  const periodsToTarget = (remaining + contribution - BigInt(1)) / contribution;
  return {
    periodsToTarget,
    reachesByDeadline:
      goal.contributionPeriodsRemaining === null
        ? null
        : periodsToTarget <= BigInt(goal.contributionPeriodsRemaining),
    deadlinePeriods: goal.contributionPeriodsRemaining,
  };
}

export function canWriteGoals(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function createHttpGoalsAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): GoalsAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";
  const key = () => `goal-${globalThis.crypto.randomUUID()}`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await request(`${baseUrl}/v1${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
    } catch {
      throw new GoalsAdapterError("Não foi possível conectar ao Casei.");
    }
    const payload = (await response.json().catch(() => null)) as
      | T
      | { error?: { message?: string; currentVersion?: number } }
      | null;
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      throw new GoalsAdapterError(
        error?.message ?? "Não foi possível atualizar a meta.",
        response.status,
        error?.currentVersion,
      );
    }
    return payload as T;
  }

  const path = (workspaceId: string, suffix = "") =>
    `/workspaces/${encodeURIComponent(workspaceId)}/goals${suffix}`;

  const mutationHeaders = (goal: Goal) => ({
    "Idempotency-Key": key(),
    "If-Match": `"v${goal.version}"`,
  });

  return {
    listGoals: async (workspaceId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const page = await call<JsonPage<Goal>>(path(workspaceId) + suffix);
      return { items: page.items, nextCursor: page.page.nextCursor, hasMore: page.page.hasMore };
    },
    listMovements: async (workspaceId, goalId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const page = await call<JsonPage<GoalMovement>>(
        path(workspaceId, `/${encodeURIComponent(goalId)}/movements`) + suffix,
      );
      return { items: page.items, nextCursor: page.page.nextCursor, hasMore: page.page.hasMore };
    },
    createGoal: (workspaceId, input) =>
      call<Goal>(path(workspaceId), {
        method: "POST",
        headers: { "Idempotency-Key": key() },
        body: JSON.stringify(input),
      }),
    updateGoal: async (workspaceId, goal, input) => {
      const result = await call<GoalMutation>(path(workspaceId, `/${goal.id}`), {
        method: "PATCH",
        headers: mutationHeaders(goal),
        body: JSON.stringify(input),
      });
      return result.goal;
    },
    allocate: (workspaceId, goal, input) =>
      call<GoalMutation>(path(workspaceId, `/${goal.id}/allocate`), {
        method: "POST",
        headers: mutationHeaders(goal),
        body: JSON.stringify(input),
      }),
    release: (workspaceId, goal, input) =>
      call<GoalMutation>(path(workspaceId, `/${goal.id}/release`), {
        method: "POST",
        headers: mutationHeaders(goal),
        body: JSON.stringify(input),
      }),
    spend: (workspaceId, goal, input) =>
      call<GoalMutation>(path(workspaceId, `/${goal.id}/spend`), {
        method: "POST",
        headers: mutationHeaders(goal),
        body: JSON.stringify(input),
      }),
    transition: (workspaceId, goal, action) =>
      call<GoalMutation>(path(workspaceId, `/${goal.id}/${action}`), {
        method: "POST",
        headers: mutationHeaders(goal),
        body: JSON.stringify({ confirm: true }),
      }),
  };
}

function fixtureGoalId(workspaceId: string, index: number): string {
  return `${workspaceId.slice(0, 18)}-goal-${index}`;
}

function fixtureContributionPeriods(deadline: string | null): number | null {
  if (!deadline) return null;
  const now = new Date();
  const today = `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
  if (deadline < today) return 0;
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const [deadlineYear, deadlineMonth, deadlineDay] = deadline.split("-").map(Number);
  let periods = (deadlineYear - todayYear) * 12 + (deadlineMonth - todayMonth);
  if (deadlineDay < todayDay) periods -= 1;
  return Math.max(1, periods);
}

function fixturePlanning(targetMinor: string, reservedMinor: string, deadline: string | null) {
  const target = BigInt(targetMinor);
  const reserved = BigInt(reservedMinor);
  const remaining = target > reserved ? target - reserved : BigInt(0);
  const contributionPeriodsRemaining = fixtureContributionPeriods(deadline);
  const requiredContribution =
    remaining > BigInt(0) && contributionPeriodsRemaining && contributionPeriodsRemaining > 0
      ? (remaining + BigInt(contributionPeriodsRemaining) - BigInt(1)) /
        BigInt(contributionPeriodsRemaining)
      : null;
  return {
    remaining: remaining.toString(),
    contributionPeriodsRemaining,
    requiredContribution: requiredContribution?.toString() ?? null,
  };
}

export function createFixtureGoalsAdapter(): GoalsAdapter {
  const goalsByWorkspace = new Map<string, Goal[]>([
    [
      "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
      [
        {
          id: fixtureGoalId("019b5d9e-3c12-7a01-8d47-7b5b5dd7a201", 1),
          workspaceId: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
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
          version: 0,
        },
      ],
    ],
  ]);
  const movements = new Map<string, GoalMovement[]>();
  const fixtureWalletBalance = BigInt(100000);
  const list = (workspaceId: string) => {
    const existing = goalsByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created: Goal[] = [];
    goalsByWorkspace.set(workspaceId, created);
    return created;
  };
  const update = (workspaceId: string, goal: Goal, next: Goal): Goal => {
    const goals = list(workspaceId);
    const index = goals.findIndex((item) => item.id === goal.id);
    if (index < 0) throw new GoalsAdapterError("Meta não encontrada.", 404);
    if (goals[index]?.version !== goal.version)
      throw new GoalsAdapterError(
        "A meta foi alterada. Atualize antes de tentar novamente.",
        412,
        goals[index]?.version,
      );
    goals[index] = next;
    return { ...next };
  };
  const refreshCoverage = (workspaceId: string) => {
    let cumulative = BigInt(0);
    for (const item of list(workspaceId)) {
      const before = cumulative;
      cumulative += BigInt(item.reserved.minor);
      const uncoveredBefore =
        before > fixtureWalletBalance ? before - fixtureWalletBalance : BigInt(0);
      const uncoveredAfter =
        cumulative > fixtureWalletBalance ? cumulative - fixtureWalletBalance : BigInt(0);
      item.uncovered = {
        ...item.uncovered,
        minor: (uncoveredAfter - uncoveredBefore).toString(),
      };
    }
  };
  const mutateAmount = (
    workspaceId: string,
    goal: Goal,
    amount: GoalMoney,
    kind: GoalMovement["kind"],
    note?: string | null,
    allowUncovered = false,
  ): GoalMutation => {
    if (amount.currency !== goal.target.currency)
      throw new GoalsAdapterError("A moeda não corresponde à do espaço.", 422);
    const current = BigInt(goal.reserved.minor);
    const delta = BigInt(amount.minor);
    if (delta <= BigInt(0) || ((kind === "release" || kind === "spend") && delta > current))
      throw new GoalsAdapterError("O valor não pode ser aplicado à reserva.", 409);
    const reserved = kind === "allocate" ? current + delta : current - delta;
    const totalBefore = list(workspaceId).reduce(
      (total, item) => total + BigInt(item.reserved.minor),
      BigInt(0),
    );
    const totalAfter = totalBefore - current + reserved;
    if (kind === "allocate" && totalAfter > fixtureWalletBalance && !allowUncovered) {
      throw new GoalsAdapterError("A reserva excede o saldo disponível do fixture.", 409);
    }
    const planning = fixturePlanning(goal.target.minor, reserved.toString(), goal.deadline);
    const next: Goal = {
      ...goal,
      reserved: { ...goal.reserved, minor: reserved.toString() },
      remaining: { ...goal.remaining, minor: planning.remaining },
      contributionPeriodsRemaining: planning.contributionPeriodsRemaining,
      requiredContribution: planning.requiredContribution
        ? { ...goal.target, minor: planning.requiredContribution }
        : null,
      status:
        reserved >= BigInt(goal.target.minor)
          ? "completed"
          : goal.status === "completed"
            ? "active"
            : goal.status,
      version: goal.version + 1,
    };
    update(workspaceId, goal, next);
    refreshCoverage(workspaceId);
    const stored = list(workspaceId).find((item) => item.id === goal.id) ?? next;
    const movement: GoalMovement = {
      id: `${goal.id}-movement-${(movements.get(goal.id)?.length ?? 0) + 1}`,
      goalId: goal.id,
      kind,
      amount,
      transactionId:
        kind === "spend" ? `${goal.id}-transaction-${movements.get(goal.id)?.length ?? 0}` : null,
      occurredOn: new Date().toISOString().slice(0, 10),
      note: note ?? null,
    };
    movements.set(goal.id, [movement, ...(movements.get(goal.id) ?? [])]);
    return { goal: { ...stored }, replayed: false };
  };
  return {
    async listGoals(workspaceId) {
      return {
        items: list(workspaceId).map((goal) => ({ ...goal })),
        nextCursor: null,
        hasMore: false,
      };
    },
    async listMovements(_workspaceId, goalId) {
      return {
        items: (movements.get(goalId) ?? []).map((movement) => ({ ...movement })),
        nextCursor: null,
        hasMore: false,
      };
    },
    async createGoal(workspaceId, input) {
      const deadline = input.deadline ?? null;
      const planning = fixturePlanning(input.target.minor, "0", deadline);
      const goal: Goal = {
        id: fixtureGoalId(workspaceId, list(workspaceId).length + 1),
        workspaceId,
        name: input.name.trim(),
        target: input.target,
        reserved: { ...input.target, minor: "0" },
        uncovered: { ...input.target, minor: "0" },
        remaining: { ...input.target, minor: planning.remaining },
        contributionPeriodsRemaining: planning.contributionPeriodsRemaining,
        requiredContribution: planning.requiredContribution
          ? { ...input.target, minor: planning.requiredContribution }
          : null,
        deadline,
        priority: input.priority ?? "normal",
        status: "active",
        note: input.note ?? null,
        version: 0,
      };
      list(workspaceId).push(goal);
      refreshCoverage(workspaceId);
      return { ...goal };
    },
    async updateGoal(workspaceId, goal, input) {
      const target = input.target ?? goal.target;
      const deadline = input.deadline !== undefined ? (input.deadline ?? null) : goal.deadline;
      const planning = fixturePlanning(target.minor, goal.reserved.minor, deadline);
      const next = update(workspaceId, goal, {
        ...goal,
        ...input,
        target,
        deadline,
        remaining: { ...target, minor: planning.remaining },
        contributionPeriodsRemaining: planning.contributionPeriodsRemaining,
        requiredContribution: planning.requiredContribution
          ? { ...target, minor: planning.requiredContribution }
          : null,
        status:
          BigInt(goal.reserved.minor) >= BigInt(target.minor)
            ? "completed"
            : goal.status === "completed"
              ? "active"
              : goal.status,
        version: goal.version + 1,
      });
      refreshCoverage(workspaceId);
      return { ...(list(workspaceId).find((item) => item.id === goal.id) ?? next) };
    },
    async allocate(workspaceId, goal, input) {
      return mutateAmount(
        workspaceId,
        goal,
        input.amount,
        "allocate",
        input.note,
        input.allowUncovered,
      );
    },
    async release(workspaceId, goal, input) {
      return mutateAmount(workspaceId, goal, input.amount, "release", input.note);
    },
    async spend(workspaceId, goal, input) {
      return mutateAmount(workspaceId, goal, input.amount, "spend", input.note);
    },
    async transition(workspaceId, goal, action) {
      const status: GoalStatus =
        action === "pause"
          ? "paused"
          : action === "resume"
            ? "active"
            : action === "complete"
              ? "completed"
              : "canceled";
      const next = update(workspaceId, goal, { ...goal, status, version: goal.version + 1 });
      return { goal: next, replayed: false };
    },
  };
}

export function goalsAdapterForEnvironment(options: { fixtures?: boolean } = {}): GoalsAdapter {
  if (
    process.env.NODE_ENV !== "production" &&
    (options.fixtures === true || process.env.CASEI_UI_FIXTURES === "1")
  )
    return createFixtureGoalsAdapter();
  const origin = configuredApiOrigin();
  return origin ? createHttpGoalsAdapter({ baseUrl: origin }) : unauthenticatedGoalsAdapter;
}
