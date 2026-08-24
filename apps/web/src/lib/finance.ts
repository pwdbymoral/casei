import { configuredApiOrigin } from "./api-origin";
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

export type StatementItem = {
  id: string;
  transactionId: string;
  statementId: string;
  type: "purchase" | "payment";
  state: Transaction["state"];
  description: string;
  occurredOn: string;
  amount: Money;
};

export type StatementItemsPage = {
  items: StatementItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type StatementItemsQuery = {
  cursor?: string | null;
  limit?: number;
};

export type TransactionPage = {
  items: Transaction[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type TransactionQuery = {
  cursor?: string | null;
  limit?: number;
  search?: string;
  from?: string;
  to?: string;
  state?: Transaction["state"];
  kind?: Transaction["kind"];
  cardId?: string;
};

/** Keeps timeline URL parsing and pagination deterministic outside the page component. */
export function transactionQueryFromSearchParams(params: URLSearchParams): TransactionQuery {
  const value = (key: string) => params.get(key) || undefined;
  return {
    cursor: value("cursor"),
    search: value("search"),
    from: value("from"),
    to: value("to"),
    state: value("state") as Transaction["state"] | undefined,
    kind: value("kind") as Transaction["kind"] | undefined,
    cardId: value("cardId"),
  };
}

/** Network/5xx failures leave a logical command safe to retry with its same key. */
export function shouldRetryIdempotentCommand(error: unknown): boolean {
  if (!(error instanceof FinanceAdapterError)) return true;
  return (
    error.status === undefined ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  );
}

export function hasTransactionQueryFilters(query: TransactionQuery): boolean {
  return Boolean(
    query.search || query.from || query.to || query.state || query.kind || query.cardId,
  );
}

export function mergeTransactionPage(
  current: Transaction[],
  page: TransactionPage,
  append: boolean,
): Transaction[] {
  return append ? [...current, ...page.items] : page.items;
}

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
  listTransactions(workspaceId: string, query?: TransactionQuery): Promise<TransactionPage>;
  createTransaction(
    workspaceId: string,
    input: CreateTransactionInput,
    idempotencyKey?: string,
  ): Promise<Transaction>;
  reverseTransaction(workspaceId: string, transaction: Transaction): Promise<Transaction>;
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
  listStatementItems(
    workspaceId: string,
    statementId: string,
    query?: StatementItemsQuery,
  ): Promise<StatementItemsPage>;
  closeStatement(workspaceId: string, statement: Statement): Promise<Statement>;
  reopenStatement(workspaceId: string, statement: Statement): Promise<Statement>;
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
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "FinanceAdapterError";
  }
}

const unavailableFinanceOperation = async (..._args: unknown[]): Promise<never> => {
  throw new FinanceAdapterError(
    "Sua sessão financeira não está disponível. Entre novamente para continuar.",
    401,
  );
};

/** Safe default for environments without an explicit authenticated API origin. */
export const unauthenticatedFinanceAdapter: FinanceAdapter = {
  listTransactions: unavailableFinanceOperation,
  createTransaction: unavailableFinanceOperation,
  reverseTransaction: unavailableFinanceOperation,
  listCategories: unavailableFinanceOperation,
  listCards: unavailableFinanceOperation,
  createCard: unavailableFinanceOperation,
  listStatements: unavailableFinanceOperation,
  listStatementItems: unavailableFinanceOperation,
  closeStatement: unavailableFinanceOperation,
  reopenStatement: unavailableFinanceOperation,
  payStatement: unavailableFinanceOperation,
  createRecurrence: unavailableFinanceOperation,
  createInstallmentPlan: unavailableFinanceOperation,
};

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
      | { error?: { message?: string; currentVersion?: number } }
      | T
      | null;
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? payload.error?.message
          : undefined;
      const currentVersion =
        payload && typeof payload === "object" && "error" in payload
          ? payload.error?.currentVersion
          : undefined;
      throw new FinanceAdapterError(
        message ?? "Não foi possível concluir a operação financeira.",
        response.status,
        currentVersion,
      );
    }
    return payload as T;
  }

  const idempotencyKey = () => `web-${crypto.randomUUID()}`;
  const listPage = async <T>(path: string) => call<JsonResponse<T>>(path);
  const list = async <T>(path: string) => (await listPage<T>(path)).items;

  return {
    listTransactions: (workspaceId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.search) params.set("search", query.search);
      if (query.from) params.set("from", query.from);
      if (query.to) params.set("to", query.to);
      if (query.state) params.set("state", query.state);
      if (query.kind) params.set("kind", query.kind);
      if (query.cardId) params.set("cardId", query.cardId);
      const search = params.toString();
      return listPage<Transaction>(
        `/workspaces/${workspaceId}/transactions${search ? `?${search}` : ""}`,
      ).then((response) => ({
        items: response.items,
        nextCursor: response.page.nextCursor,
        hasMore: response.page.hasMore,
      }));
    },
    createTransaction: async (workspaceId, input, commandKey) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions`, {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? idempotencyKey() },
        body: JSON.stringify(input),
      }),
    reverseTransaction: (workspaceId, transaction) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions/${transaction.id}/reverse`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${transaction.version}"`,
        },
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
    listStatementItems: (workspaceId, statementId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const search = params.toString();
      return listPage<StatementItem>(
        `/workspaces/${workspaceId}/statements/${statementId}/items${search ? `?${search}` : ""}`,
      ).then((response) => ({
        items: response.items,
        nextCursor: response.page.nextCursor,
        hasMore: response.page.hasMore,
      }));
    },
    closeStatement: (workspaceId, statement) =>
      call<Statement>(`/workspaces/${workspaceId}/statements/${statement.id}/close`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${statement.version}"`,
        },
        body: JSON.stringify({ confirm: true }),
      }),
    reopenStatement: (workspaceId, statement) =>
      call<Statement>(`/workspaces/${workspaceId}/statements/${statement.id}/reopen`, {
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
    listTransactions: async (_workspaceId, query = {}) => {
      const filtered = transactions.filter((transaction) => {
        if (
          query.search &&
          !transaction.description.toLowerCase().includes(query.search.toLowerCase())
        )
          return false;
        if (query.from && transaction.occurredOn < query.from) return false;
        if (query.to && transaction.occurredOn > query.to) return false;
        if (query.state && transaction.state !== query.state) return false;
        if (query.kind && transaction.kind !== query.kind) return false;
        if (query.cardId && transaction.cardId !== query.cardId) return false;
        return true;
      });
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const offset = query.cursor?.startsWith("fixture:")
        ? Number.parseInt(query.cursor.slice("fixture:".length), 10)
        : 0;
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const items = filtered.slice(start, start + limit);
      const hasMore = start + limit < filtered.length;
      return {
        items,
        nextCursor: hasMore ? `fixture:${start + limit}` : null,
        hasMore,
      };
    },
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
    reverseTransaction: async (_workspaceId, transaction) => {
      const current = transactions.find((value) => value.id === transaction.id);
      if (!current) throw new FinanceAdapterError("Lançamento não encontrado.", 404);
      const value = { ...current, state: "canceled" as const, version: current.version + 1 };
      transactions[transactions.indexOf(current)] = value;
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
    listStatementItems: async (_workspaceId, statementId, query = {}) => {
      const allItems = transactions
        .filter((transaction) => transaction.statementId === statementId)
        .map((transaction) => ({
          id: transaction.id,
          transactionId: transaction.id,
          statementId,
          type: transaction.kind === "transfer" ? ("payment" as const) : ("purchase" as const),
          state: transaction.state,
          description: transaction.description,
          occurredOn: transaction.occurredOn,
          amount: transaction.amount,
        }));
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const offset = query.cursor?.startsWith("fixture:")
        ? Number.parseInt(query.cursor.slice("fixture:".length), 10)
        : 0;
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const items = allItems.slice(start, start + limit);
      const hasMore = start + limit < allItems.length;
      return {
        items,
        nextCursor: hasMore ? `fixture:${start + limit}` : null,
        hasMore,
      };
    },
    closeStatement: async (_workspaceId, statement) => {
      const value = { ...statement, state: "closed" as const, version: statement.version + 1 };
      const index = statements.findIndex(({ id }) => id === statement.id);
      if (index >= 0) statements[index] = value;
      return value;
    },
    reopenStatement: async (_workspaceId, statement) => {
      if (statement.state !== "closed" || BigInt(statement.paid.minor) > BigInt(0)) {
        throw new FinanceAdapterError(
          "Apenas faturas fechadas e sem pagamentos podem ser reabertas.",
          409,
        );
      }
      const value = { ...statement, state: "open" as const, version: statement.version + 1 };
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

export function financeAdapterForEnvironment(options: { fixtures?: boolean } = {}): FinanceAdapter {
  if (
    process.env.NODE_ENV !== "production" &&
    (options.fixtures === true || process.env.CASEI_UI_FIXTURES === "1")
  ) {
    return createFixtureFinanceAdapter();
  }
  const origin = configuredApiOrigin();
  return origin ? createHttpFinanceAdapter({ baseUrl: origin }) : unauthenticatedFinanceAdapter;
}

export function canWriteFinance(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function statementItemAmountPrefix(item: Pick<StatementItem, "type" | "state">): string {
  if (item.state === "canceled") return "Cancelada · ";
  return item.type === "payment" ? "−" : "+";
}

export function createRequestGuard() {
  let latestRequest = 0;
  return {
    begin(): number {
      latestRequest += 1;
      return latestRequest;
    },
    invalidate(): void {
      latestRequest += 1;
    },
    isCurrent(request: number): boolean {
      return request === latestRequest;
    },
  };
}
