import type { WorkspaceRole } from "./workspaces";

export type Money = { currency: string; minor: string };
export type Transaction = {
  id: string;
  workspaceId: string;
  kind: "income" | "expense" | "transfer" | "adjustment";
  state: "planned" | "partially_settled" | "posted" | "canceled";
  amount: Money;
  settledAmount: Money;
  occurredOn: string;
  dueOn: string | null;
  postedOn: string | null;
  description: string;
  categoryId: string | null;
  cardId: string | null;
  statementId: string | null;
  version: number;
};

export type CreditCard = {
  id: string;
  workspaceId: string;
  name: string;
  closingDay: number;
  dueDay: number;
  holder: string | null;
  lastFour: string | null;
  limit: Money | null;
  archived: boolean;
  version: number;
};

export type Statement = {
  id: string;
  workspaceId: string;
  cardId: string;
  periodStart: string;
  closingOn: string;
  dueOn: string;
  state: "open" | "closed" | "partially_paid" | "paid" | "canceled";
  total: Money;
  paid: Money;
  openAmount: Money;
  version: number;
};

export type Category = {
  id: string;
  workspaceId: string;
  name: string;
  kind: "income" | "expense" | "both";
  archived: boolean;
  version: number;
};

export type CreateTransactionInput = {
  kind: "income" | "expense";
  amount: Money;
  occurredOn?: string;
  dueOn?: string | null;
  state?: "planned" | "posted";
  description?: string;
  categoryId?: string | null;
  cardId?: string | null;
};

export type FinanceAdapter = {
  listTransactions(workspaceId: string): Promise<Transaction[]>;
  createTransaction(workspaceId: string, input: CreateTransactionInput): Promise<Transaction>;
  listCategories(workspaceId: string): Promise<Category[]>;
  listCards(workspaceId: string): Promise<CreditCard[]>;
  createCard(
    workspaceId: string,
    input: {
      name: string;
      closingDay: number;
      dueDay: number;
      holder?: string | null;
      lastFour?: string | null;
      limit?: Money | null;
    },
  ): Promise<CreditCard>;
  listStatements(workspaceId: string, cardId?: string): Promise<Statement[]>;
  closeStatement(workspaceId: string, statement: Statement): Promise<Statement>;
  payStatement(
    workspaceId: string,
    statement: Statement,
    amount?: Money,
  ): Promise<{ statementId: string; transactionId: string; amount: Money }>;
  createRecurrence(
    workspaceId: string,
    input: {
      kind: "income" | "expense";
      amount: Money;
      frequency: "weekly" | "monthly" | "annual";
      interval: number;
      startOn: string;
      endOn?: string | null;
      maxOccurrences?: number | null;
      variable: boolean;
      estimatedAmount?: Money | null;
      description?: string;
    },
  ): Promise<{ id: string; occurrences: string[] }>;
  createInstallmentPlan(
    workspaceId: string,
    input: { total: Money; count: number; firstDueOn: string; description?: string },
  ): Promise<{
    id: string;
    total: Money;
    count: number;
    installments: Array<{ id: string; number: number; amount: Money; dueOn: string }>;
  }>;
};

export class FinanceAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FinanceAdapterError";
  }
}

type JsonResponse<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };

export function createHttpFinanceAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): FinanceAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await request(`${baseUrl}/v1${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | T
      | null;
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? payload.error?.message
          : undefined;
      throw new FinanceAdapterError(
        message ?? "Não foi possível concluir a operação financeira.",
        response.status,
      );
    }
    return payload as T;
  }

  const idempotencyKey = () => `web-${crypto.randomUUID()}`;
  const list = async <T>(path: string) => (await call<JsonResponse<T>>(path)).items;

  return {
    listTransactions: (workspaceId) => list<Transaction>(`/workspaces/${workspaceId}/transactions`),
    createTransaction: async (workspaceId, input) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
    listCategories: (workspaceId) => list<Category>(`/workspaces/${workspaceId}/categories`),
    listCards: (workspaceId) => list<CreditCard>(`/workspaces/${workspaceId}/cards`),
    createCard: (workspaceId, input) =>
      call<CreditCard>(`/workspaces/${workspaceId}/cards`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
    listStatements: (workspaceId, cardId) =>
      list<Statement>(
        `/workspaces/${workspaceId}/statements${cardId ? `?cardId=${encodeURIComponent(cardId)}` : ""}`,
      ),
    closeStatement: (workspaceId, statement) =>
      call<Statement>(`/workspaces/${workspaceId}/statements/${statement.id}/close`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${statement.version}"`,
        },
        body: JSON.stringify({ confirm: true }),
      }),
    payStatement: async (workspaceId, statement, amount) =>
      call<{ statementId: string; transactionId: string; amount: Money }>(
        `/workspaces/${workspaceId}/statements/${statement.id}/payments`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify({ amount }),
        },
      ),
    createRecurrence: (workspaceId, input) =>
      call<{ id: string; occurrences: string[] }>(`/workspaces/${workspaceId}/recurrences`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
    createInstallmentPlan: (workspaceId, input) =>
      call<
        FinanceAdapter["createInstallmentPlan"] extends (...args: never[]) => Promise<infer T>
          ? T
          : never
      >(`/workspaces/${workspaceId}/installments`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
  };
}

const fixtureWorkspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
const fixtureCardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
const fixtureStatementId = "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211";

function fixtureId(seed: number): string {
  return `019b5d9e-3c12-7a${String(seed).padStart(2, "0")}-8d47-7b5b5dd7a2${String(seed).padStart(2, "2")}`;
}

/** Local-only data makes the shell usable before AUTH-002 supplies a session API. */
export function createFixtureFinanceAdapter(): FinanceAdapter {
  const transactions: Transaction[] = [];
  const cards: CreditCard[] = [
    {
      id: fixtureCardId,
      workspaceId: fixtureWorkspaceId,
      name: "Cartão principal",
      closingDay: 10,
      dueDay: 17,
      holder: "Marina",
      lastFour: "4242",
      limit: { currency: "BRL", minor: "500000" },
      archived: false,
      version: 0,
    },
  ];
  const statements: Statement[] = [
    {
      id: fixtureStatementId,
      workspaceId: fixtureWorkspaceId,
      cardId: fixtureCardId,
      periodStart: "2026-08-11",
      closingOn: "2026-09-10",
      dueOn: "2026-09-17",
      state: "open",
      total: { currency: "BRL", minor: "0" },
      paid: { currency: "BRL", minor: "0" },
      openAmount: { currency: "BRL", minor: "0" },
      version: 0,
    },
  ];
  return {
    listTransactions: async () => [...transactions],
    createTransaction: async (workspaceId, input) => {
      const value: Transaction = {
        id: fixtureId(transactions.length + 1),
        workspaceId,
        kind: input.kind,
        state: input.state ?? "posted",
        amount: input.amount,
        settledAmount:
          (input.state ?? "posted") === "posted" ? input.amount : { ...input.amount, minor: "0" },
        occurredOn: input.occurredOn ?? new Date().toISOString().slice(0, 10),
        dueOn: input.dueOn ?? null,
        postedOn: (input.state ?? "posted") === "posted" ? new Date().toISOString() : null,
        description: input.description ?? "",
        categoryId: input.categoryId ?? null,
        cardId: input.cardId ?? null,
        statementId: null,
        version: 0,
      };
      transactions.unshift(value);
      if (input.cardId) {
        const statement = statements.find(
          (item) => item.cardId === input.cardId && item.state === "open",
        );
        if (statement) {
          const total = BigInt(statement.total.minor) + BigInt(input.amount.minor);
          statement.total = { ...statement.total, minor: total.toString() };
          statement.openAmount = {
            ...statement.openAmount,
            minor: (total - BigInt(statement.paid.minor)).toString(),
          };
          value.statementId = statement.id;
        }
      }
      return value;
    },
    listCategories: async () => [],
    listCards: async () => [...cards],
    createCard: async (workspaceId, input) => {
      const card: CreditCard = {
        id: fixtureId(cards.length + 10),
        workspaceId,
        name: input.name,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
        holder: input.holder ?? null,
        lastFour: input.lastFour ?? null,
        limit: input.limit ?? null,
        archived: false,
        version: 0,
      };
      cards.push(card);
      return card;
    },
    listStatements: async (_workspaceId, cardId) =>
      statements.filter((statement) => !cardId || statement.cardId === cardId),
    closeStatement: async (_workspaceId, statement) => {
      const value = { ...statement, state: "closed" as const, version: statement.version + 1 };
      const index = statements.findIndex(({ id }) => id === statement.id);
      if (index >= 0) statements[index] = value;
      return value;
    },
    payStatement: async (_workspaceId, statement, amount) => {
      const paid = amount ?? statement.openAmount;
      const nextPaid = BigInt(statement.paid.minor) + BigInt(paid.minor);
      const nextOpen = BigInt(statement.total.minor) - nextPaid;
      const index = statements.findIndex(({ id }) => id === statement.id);
      if (index >= 0) {
        statements[index] = {
          ...statement,
          paid: { ...paid, minor: nextPaid.toString() },
          openAmount: { ...paid, minor: nextOpen.toString() },
          state: nextOpen <= BigInt(0) ? "paid" : "partially_paid",
          version: statement.version + 1,
        };
      }
      return { statementId: statement.id, transactionId: fixtureId(80), amount: paid };
    },
    createRecurrence: async () => ({ id: fixtureId(90), occurrences: [] }),
    createInstallmentPlan: async (_workspaceId, input) => ({
      id: fixtureId(91),
      total: input.total,
      count: input.count,
      installments: [],
    }),
  };
}

export function financeAdapterForEnvironment(): FinanceAdapter {
  return process.env.NODE_ENV === "production"
    ? createHttpFinanceAdapter({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "" })
    : createFixtureFinanceAdapter();
}

export function canWriteFinance(role: WorkspaceRole): boolean {
  return role !== "viewer";
}
