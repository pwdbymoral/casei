import { configuredApiOrigin } from "./api-origin";
import type { WorkspaceRole } from "./workspaces";

export type Money = { currency: string; minor: string };
export type Wallet = {
  workspaceId: string;
  balance: Money;
  version: number;
};
export type WalletAdjustmentPreview = {
  wallet: Wallet;
  observedBalance: Money;
  difference: Money;
};
export type WalletAdjustmentResult = WalletAdjustmentPreview & {
  transaction: Transaction;
};
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
  /** Source plan identifiers are returned when the fact belongs to a series. */
  recurrenceId?: string | null;
  installmentPlanId?: string | null;
  version: number;
};

export type Recurrence = {
  id: string;
  workspaceId: string;
  kind: "income" | "expense";
  amount: Money;
  frequency: "weekly" | "monthly" | "annual";
  interval: number;
  startOn: string;
  endOn: string | null;
  maxOccurrences: number | null;
  variable: boolean;
  estimatedAmount: Money | null;
  description: string;
  pausedOn: string | null;
  version: number;
};

export type RecurrenceEditInput = {
  scope: "this" | "this_and_future" | "future_unsettled";
  effectiveOn: string;
  amount?: Money;
  description?: string;
  endOn?: string | null;
  estimatedAmount?: Money | null;
};

export type RecurrenceEditResponse = {
  recurrence: Recurrence;
  affectedOccurrences: string[];
};

export type Installment = {
  id: string;
  number: number;
  amount: Money;
  dueOn: string;
  transactionId: string;
  state: string;
  version: number;
};

export type InstallmentPlan = {
  id: string;
  workspaceId: string;
  total: Money;
  count: number;
  firstDueOn: string;
  version: number;
  installments: Installment[];
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

export type UpdateCreditCardInput = {
  name?: string;
  closingDay?: number;
  dueDay?: number;
  holder?: string | null;
  lastFour?: string | null;
  limit?: Money | null;
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
  creditApplied?: Money;
  version: number;
};

export type StatementItem = {
  id: string;
  transactionId: string;
  statementId: string;
  type: "purchase" | "payment" | "adjustment" | "refund";
  state: Transaction["state"];
  description: string;
  occurredOn: string;
  amount: Money;
};

export type StatementAdjustmentResult = {
  transaction: Transaction;
  statement: Statement;
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

export type FinanceAuditEvent = {
  id: string;
  transactionId: string;
  category: string;
  action: string;
  actorId: string | null;
  occurredAt: string;
  origin: string;
  correlationId: string;
  result: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type FinanceAuditLedgerEvent = {
  id: string;
  eventType: string;
  status: string;
  occurredOn: string;
  publishedAt: string | null;
  reversedEventId: string | null;
};

export type FinanceAuditDetail = FinanceAuditEvent & {
  consequences: { ledgerEvents: FinanceAuditLedgerEvent[] };
};

export type FinanceAuditPage = {
  items: FinanceAuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type FinanceAuditQuery = {
  cursor?: string | null;
  limit?: number;
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

/** Removes timeline filters and pagination while preserving unrelated URL state. */
export function clearTransactionQueryParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ["search", "from", "to", "state", "kind", "cardId", "cursor"]) {
    next.delete(key);
  }
  return next;
}

export function createQuickCaptureTransactionInput(input: {
  kind: "income" | "expense";
  amountMinor: string;
  currency: string;
  planned: boolean;
  description: string;
  cardId: string;
  categoryId?: string;
}): CreateTransactionInput {
  return {
    kind: input.kind,
    amount: { currency: input.currency, minor: input.amountMinor },
    state: input.planned ? "planned" : "posted",
    description: input.description,
    cardId: transactionCardIdForKind(input.kind, input.cardId),
    categoryId: input.categoryId || null,
  };
}

export function transactionCardIdForKind(
  kind: "income" | "expense",
  cardId: string,
): string | null {
  return kind === "expense" ? cardId || null : null;
}

export function transactionKindLabel(transaction: Pick<Transaction, "kind" | "cardId">): string {
  if (transaction.kind === "income") return "Receita";
  if (transaction.kind === "expense") {
    return transaction.cardId ? "Compra no cartão" : "Despesa";
  }
  return transaction.kind === "transfer" ? "Transferência" : "Ajuste";
}

export function transactionAmountPrefix(kind: Transaction["kind"]): string {
  if (kind === "income") return "+";
  if (kind === "expense") return "−";
  return kind === "transfer" ? "↔" : "±";
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

/** Closing or changing a correction form while its request is pending must not lose its key. */
export function shouldPreserveStatementAdjustmentCommandKey(saving: boolean): boolean {
  return saving;
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

/** Keeps only selections that are still present after a filter/page refresh. */
export function retainVisibleTransactionSelection(
  selectedIds: readonly string[],
  visibleTransactions: readonly Pick<Transaction, "id">[],
): string[] {
  const visibleIds = new Set(visibleTransactions.map((transaction) => transaction.id));
  return selectedIds.filter((id) => visibleIds.has(id));
}

export function commitmentRemainingMinor(
  transaction: Pick<Transaction, "amount" | "settledAmount">,
): string {
  const remaining = BigInt(transaction.amount.minor) - BigInt(transaction.settledAmount.minor);
  return (remaining > BigInt(0) ? remaining : BigInt(0)).toString();
}

/**
 * Returns the canonical wallet delta represented by the transaction's
 * published settlement. Card purchases affect the card liability, not cash;
 * invoice payments are transfers out of the wallet and are identified by the
 * statement link. Planned facts have no published cash delta yet.
 */
export function walletDeltaMinor(
  transaction: Pick<Transaction, "kind" | "state" | "cardId" | "statementId" | "settledAmount">,
): string {
  if (transaction.state !== "posted" && transaction.state !== "partially_settled") return "0";
  if (transaction.cardId) return "0";
  const settled = BigInt(transaction.settledAmount.minor);
  if (settled <= BigInt(0)) return "0";
  if (transaction.kind === "income") return settled.toString();
  if (transaction.kind === "expense") return `-${settled.toString()}`;
  if (transaction.kind === "transfer" && transaction.statementId) return `-${settled.toString()}`;
  return "0";
}

/**
 * Sums the wallet effects represented by a transaction snapshot.
 *
 * A timeline page and the unfiltered commitment read can overlap, so the
 * calculation is keyed by transaction ID before summing. This keeps a
 * partially settled fact and its refreshed copy from changing the balance
 * twice while still accounting for statement-payment transfers.
 */
export function walletTotalMinor(
  transactions: ReadonlyArray<
    Pick<Transaction, "id" | "kind" | "state" | "cardId" | "statementId" | "settledAmount">
  >,
): string {
  const unique = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  return [...unique.values()]
    .reduce((total, transaction) => total + BigInt(walletDeltaMinor(transaction)), BigInt(0))
    .toString();
}

export function commitmentBucket(
  transaction: Pick<Transaction, "state" | "dueOn">,
  today: string,
): "upcoming" | "overdue" | null {
  if (
    (transaction.state !== "planned" && transaction.state !== "partially_settled") ||
    transaction.dueOn === null
  )
    return null;
  return transaction.dueOn < today ? "overdue" : "upcoming";
}

/** Deterministic cent distribution used for the local preflight before submit. */
export function previewInstallmentMinor(totalMinor: string, count: number): string[] {
  let total: bigint;
  try {
    total = BigInt(totalMinor);
  } catch {
    return [];
  }
  if (total <= BigInt(0) || !Number.isSafeInteger(count) || count < 2 || count > 999) return [];
  const base = total / BigInt(count);
  const remainder = total % BigInt(count);
  return Array.from({ length: count }, (_, index) =>
    (base + (BigInt(index) < remainder ? BigInt(1) : BigInt(0))).toString(),
  );
}

export function previewInstallmentDates(firstDueOn: string, count: number): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstDueOn);
  if (!match || !Number.isSafeInteger(count) || count < 2 || count > 999) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  return Array.from({ length: count }, (_, index) => {
    const absoluteMonth = month - 1 + index;
    const targetYear = year + Math.floor(absoluteMonth / 12);
    const targetMonth = absoluteMonth % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(day, lastDay);
    return `${targetYear.toString().padStart(4, "0")}-${(targetMonth + 1).toString().padStart(2, "0")}-${targetDay.toString().padStart(2, "0")}`;
  });
}

/** Formats a civil calendar date in the workspace IANA timezone. */
export function civilDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(
    parts
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new Error("Não foi possível determinar a data do espaço.");
  return `${year}-${month}-${day}`;
}

export type Category = {
  id: string;
  workspaceId: string;
  name: string;
  kind: "income" | "expense" | "both";
  archived: boolean;
  version: number;
};

export type TransactionReclassificationSelection = { id: string; version: number };
export type TransactionReclassificationInput = {
  categoryId: string;
  transactions: TransactionReclassificationSelection[];
};
export type TransactionReclassificationPreviewRow = {
  transactionId: string;
  currentCategoryId: string | null;
  categoryId: string;
  version: number;
  status: "ready" | "invalid";
  errors: string[];
};
export type TransactionReclassificationPreview = {
  categoryId: string;
  categoryVersion: number;
  previewHash: string;
  rows: TransactionReclassificationPreviewRow[];
  canConfirm: boolean;
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

export type SettlementInput = {
  amount?: Money;
  occurredOn?: string;
};

export type UpdateCategoryInput = { name?: string; kind?: Category["kind"] };

export type FinanceAdapter = {
  getWallet(workspaceId: string): Promise<Wallet>;
  previewWalletAdjustment(
    workspaceId: string,
    observedBalance: Money,
  ): Promise<WalletAdjustmentPreview>;
  adjustWallet(
    workspaceId: string,
    wallet: Wallet,
    input: { observedBalance: Money; reason: string },
    idempotencyKey?: string,
  ): Promise<WalletAdjustmentResult>;
  listTransactions(workspaceId: string, query?: TransactionQuery): Promise<TransactionPage>;
  getTransaction(workspaceId: string, transactionId: string): Promise<Transaction>;
  listTransactionAudit(
    workspaceId: string,
    transactionId: string,
    query?: FinanceAuditQuery,
  ): Promise<FinanceAuditPage>;
  getTransactionAudit(
    workspaceId: string,
    transactionId: string,
    auditId: string,
  ): Promise<FinanceAuditDetail>;
  createTransaction(
    workspaceId: string,
    input: CreateTransactionInput,
    idempotencyKey?: string,
  ): Promise<Transaction>;
  postTransaction(
    workspaceId: string,
    transaction: Transaction,
    input?: SettlementInput,
    idempotencyKey?: string,
  ): Promise<Transaction>;
  reverseTransaction(
    workspaceId: string,
    transaction: Transaction,
    idempotencyKey?: string,
  ): Promise<Transaction>;
  listCategories(workspaceId: string): Promise<Category[]>;
  createCategory(
    workspaceId: string,
    input: { name: string; kind: Category["kind"] },
  ): Promise<Category>;
  updateCategory(
    workspaceId: string,
    category: Category,
    input: UpdateCategoryInput,
  ): Promise<Category>;
  archiveCategory(workspaceId: string, category: Category): Promise<Category>;
  restoreCategory(workspaceId: string, category: Category): Promise<Category>;
  previewTransactionReclassification(
    workspaceId: string,
    input: TransactionReclassificationInput,
  ): Promise<TransactionReclassificationPreview>;
  reclassifyTransactions(
    workspaceId: string,
    input: TransactionReclassificationInput,
    preview: TransactionReclassificationPreview,
    commandKey?: string,
  ): Promise<{
    committed: boolean;
    preview: TransactionReclassificationPreview;
    transactions: Transaction[];
  }>;
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
  updateCard(
    workspaceId: string,
    card: CreditCard,
    input: UpdateCreditCardInput,
  ): Promise<CreditCard>;
  archiveCard(workspaceId: string, card: CreditCard): Promise<CreditCard>;
  listStatements(workspaceId: string, cardId?: string): Promise<Statement[]>;
  getStatement(workspaceId: string, statementId: string): Promise<Statement>;
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
    idempotencyKey?: string,
  ): Promise<{ statementId: string; transactionId: string; amount: Money }>;
  createStatementAdjustment(
    workspaceId: string,
    statement: Statement,
    input: {
      kind: "charge" | "fee" | "interest";
      amount: Money;
      occurredOn?: string;
      description: string;
    },
    idempotencyKey?: string,
  ): Promise<StatementAdjustmentResult>;
  createStatementRefund(
    workspaceId: string,
    statement: Statement,
    input: {
      sourceTransactionId: string;
      amount: Money;
      occurredOn?: string;
      description?: string;
    },
    idempotencyKey?: string,
  ): Promise<StatementAdjustmentResult>;
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
    idempotencyKey?: string,
  ): Promise<{ id: string; occurrences: string[] }>;
  getRecurrence(workspaceId: string, recurrenceId: string): Promise<Recurrence>;
  updateRecurrence(
    workspaceId: string,
    recurrence: Recurrence,
    input: RecurrenceEditInput,
    idempotencyKey?: string,
  ): Promise<RecurrenceEditResponse>;
  transitionRecurrence(
    workspaceId: string,
    recurrence: Recurrence,
    action: "pause" | "resume",
    effectiveOn?: string,
    idempotencyKey?: string,
  ): Promise<Recurrence>;
  createInstallmentPlan(
    workspaceId: string,
    input: { total: Money; count: number; firstDueOn: string; description?: string },
    idempotencyKey?: string,
  ): Promise<{
    id: string;
    total: Money;
    count: number;
    installments: Array<{ id: string; number: number; amount: Money; dueOn: string }>;
  }>;
  getInstallmentPlan(workspaceId: string, planId: string): Promise<InstallmentPlan>;
  updateInstallmentPlan(
    workspaceId: string,
    plan: InstallmentPlan,
    input: { total?: Money; count?: number; firstDueOn?: string; description?: string },
    idempotencyKey?: string,
  ): Promise<InstallmentPlan>;
  updateInstallment(
    workspaceId: string,
    plan: InstallmentPlan,
    installment: Installment,
    input: { amount?: Money; dueOn?: string; description?: string },
    idempotencyKey?: string,
  ): Promise<InstallmentPlan>;
  cancelFutureInstallments(
    workspaceId: string,
    plan: InstallmentPlan,
    idempotencyKey?: string,
  ): Promise<InstallmentPlan>;
};

/**
 * Reads every page for an unfiltered client-side commitment model. The wallet
 * has its own canonical aggregate endpoint; this cursor loop ensures planned
 * commitments beyond the first timeline page are not silently omitted.
 */
export async function listAllTransactions(
  adapter: FinanceAdapter,
  workspaceId: string,
  query: Omit<TransactionQuery, "cursor" | "limit"> = {},
): Promise<Transaction[]> {
  const items: Transaction[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.listTransactions(workspaceId, {
      ...query,
      cursor,
      limit: 100,
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error("A paginação financeira retornou um cursor inválido.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

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
  getWallet: unavailableFinanceOperation,
  previewWalletAdjustment: unavailableFinanceOperation,
  adjustWallet: unavailableFinanceOperation,
  listTransactions: unavailableFinanceOperation,
  getTransaction: unavailableFinanceOperation,
  listTransactionAudit: unavailableFinanceOperation,
  getTransactionAudit: unavailableFinanceOperation,
  createTransaction: unavailableFinanceOperation,
  postTransaction: unavailableFinanceOperation,
  reverseTransaction: unavailableFinanceOperation,
  listCategories: unavailableFinanceOperation,
  createCategory: unavailableFinanceOperation,
  updateCategory: unavailableFinanceOperation,
  archiveCategory: unavailableFinanceOperation,
  restoreCategory: unavailableFinanceOperation,
  previewTransactionReclassification: unavailableFinanceOperation,
  reclassifyTransactions: unavailableFinanceOperation,
  listCards: unavailableFinanceOperation,
  createCard: unavailableFinanceOperation,
  updateCard: unavailableFinanceOperation,
  archiveCard: unavailableFinanceOperation,
  listStatements: unavailableFinanceOperation,
  getStatement: unavailableFinanceOperation,
  listStatementItems: unavailableFinanceOperation,
  closeStatement: unavailableFinanceOperation,
  reopenStatement: unavailableFinanceOperation,
  payStatement: unavailableFinanceOperation,
  createStatementAdjustment: unavailableFinanceOperation,
  createStatementRefund: unavailableFinanceOperation,
  createRecurrence: unavailableFinanceOperation,
  getRecurrence: unavailableFinanceOperation,
  updateRecurrence: unavailableFinanceOperation,
  transitionRecurrence: unavailableFinanceOperation,
  createInstallmentPlan: unavailableFinanceOperation,
  getInstallmentPlan: unavailableFinanceOperation,
  updateInstallmentPlan: unavailableFinanceOperation,
  updateInstallment: unavailableFinanceOperation,
  cancelFutureInstallments: unavailableFinanceOperation,
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
    getWallet: (workspaceId) =>
      call<Wallet>(`/workspaces/${encodeURIComponent(workspaceId)}/wallet`),
    previewWalletAdjustment: (workspaceId, observedBalance) =>
      call<WalletAdjustmentPreview>(
        `/workspaces/${encodeURIComponent(workspaceId)}/wallet/adjustments/preview`,
        {
          method: "POST",
          body: JSON.stringify({ observedBalance }),
        },
      ),
    adjustWallet: (workspaceId, wallet, input, commandKey) =>
      call<WalletAdjustmentResult>(
        `/workspaces/${encodeURIComponent(workspaceId)}/wallet/adjustments`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${wallet.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
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
    getTransaction: (workspaceId, transactionId) =>
      call<Transaction>(
        `/workspaces/${encodeURIComponent(workspaceId)}/transactions/${encodeURIComponent(transactionId)}`,
      ),
    listTransactionAudit: (workspaceId, transactionId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const search = params.toString();
      return listPage<FinanceAuditEvent>(
        `/workspaces/${workspaceId}/transactions/${transactionId}/audit${search ? `?${search}` : ""}`,
      ).then((response) => ({
        items: response.items,
        nextCursor: response.page.nextCursor,
        hasMore: response.page.hasMore,
      }));
    },
    getTransactionAudit: (workspaceId, transactionId, auditId) =>
      call<FinanceAuditDetail>(
        `/workspaces/${workspaceId}/transactions/${transactionId}/audit/${auditId}`,
      ),
    createTransaction: async (workspaceId, input, commandKey) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions`, {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? idempotencyKey() },
        body: JSON.stringify(input),
      }),
    postTransaction: (workspaceId, transaction, input = {}, commandKey) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions/${transaction.id}/post`, {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? idempotencyKey(),
          "If-Match": `"v${transaction.version}"`,
        },
        body: JSON.stringify(input),
      }),
    reverseTransaction: (workspaceId, transaction, commandKey) =>
      call<Transaction>(`/workspaces/${workspaceId}/transactions/${transaction.id}/reverse`, {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? idempotencyKey(),
          "If-Match": `"v${transaction.version}"`,
        },
      }),
    listCategories: (workspaceId) => list<Category>(`/workspaces/${workspaceId}/categories`),
    createCategory: (workspaceId, input) =>
      call<Category>(`/workspaces/${workspaceId}/categories`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
    updateCategory: (workspaceId, category, input) =>
      call<Category>(`/workspaces/${workspaceId}/categories/${category.id}`, {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${category.version}"`,
        },
        body: JSON.stringify(input),
      }),
    archiveCategory: (workspaceId, category) =>
      call<Category>(`/workspaces/${workspaceId}/categories/${category.id}/archive`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${category.version}"`,
        },
        body: JSON.stringify({ confirm: true }),
      }),
    restoreCategory: (workspaceId, category) =>
      call<Category>(`/workspaces/${workspaceId}/categories/${category.id}/restore`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${category.version}"`,
        },
        body: JSON.stringify({ confirm: true }),
      }),
    previewTransactionReclassification: (workspaceId, input) =>
      call<TransactionReclassificationPreview>(
        `/workspaces/${encodeURIComponent(workspaceId)}/transactions/reclassify/preview`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    reclassifyTransactions: (workspaceId, input, preview, commandKey) =>
      call<{
        committed: boolean;
        preview: TransactionReclassificationPreview;
        transactions: Transaction[];
      }>(`/workspaces/${encodeURIComponent(workspaceId)}/transactions/reclassify`, {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? idempotencyKey(),
          "If-Match": `"v${preview.categoryVersion}"`,
        },
        body: JSON.stringify({ ...input, previewHash: preview.previewHash }),
      }),
    listCards: (workspaceId) => list<CreditCard>(`/workspaces/${workspaceId}/cards`),
    createCard: (workspaceId, input) =>
      call<CreditCard>(`/workspaces/${workspaceId}/cards`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify(input),
      }),
    updateCard: (workspaceId, card, input) =>
      call<CreditCard>(`/workspaces/${workspaceId}/cards/${card.id}`, {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${card.version}"`,
        },
        body: JSON.stringify(input),
      }),
    archiveCard: (workspaceId, card) =>
      call<CreditCard>(`/workspaces/${workspaceId}/cards/${card.id}/archive`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey(),
          "If-Match": `"v${card.version}"`,
        },
      }),
    listStatements: (workspaceId, cardId) =>
      list<Statement>(
        `/workspaces/${workspaceId}/statements${cardId ? `?cardId=${encodeURIComponent(cardId)}` : ""}`,
      ),
    getStatement: (workspaceId, statementId) =>
      call<Statement>(
        `/workspaces/${encodeURIComponent(workspaceId)}/statements/${encodeURIComponent(statementId)}`,
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
    payStatement: async (workspaceId, statement, amount, commandKey) =>
      call<{ statementId: string; transactionId: string; amount: Money }>(
        `/workspaces/${workspaceId}/statements/${statement.id}/payments`,
        {
          method: "POST",
          headers: { "Idempotency-Key": commandKey ?? idempotencyKey() },
          body: JSON.stringify({ amount }),
        },
      ),
    createStatementAdjustment: (workspaceId, statement, input, commandKey) =>
      call<StatementAdjustmentResult>(
        `/workspaces/${workspaceId}/statements/${statement.id}/adjustments`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${statement.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
    createStatementRefund: (workspaceId, statement, input, commandKey) =>
      call<StatementAdjustmentResult>(
        `/workspaces/${workspaceId}/statements/${statement.id}/refunds`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${statement.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
    createRecurrence: (workspaceId, input, commandKey) =>
      call<{ id: string; occurrences: string[] }>(`/workspaces/${workspaceId}/recurrences`, {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? idempotencyKey() },
        body: JSON.stringify(input),
      }),
    getRecurrence: (workspaceId, recurrenceId) =>
      call<Recurrence>(
        `/workspaces/${encodeURIComponent(workspaceId)}/recurrences/${encodeURIComponent(recurrenceId)}`,
      ),
    updateRecurrence: (workspaceId, recurrence, input, commandKey) =>
      call<RecurrenceEditResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/recurrences/${encodeURIComponent(recurrence.id)}`,
        {
          method: "PATCH",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${recurrence.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
    transitionRecurrence: (workspaceId, recurrence, action, effectiveOn, commandKey) =>
      call<Recurrence>(
        `/workspaces/${encodeURIComponent(workspaceId)}/recurrences/${encodeURIComponent(recurrence.id)}/${action}`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${recurrence.version}"`,
          },
          body: JSON.stringify(effectiveOn ? { effectiveOn } : {}),
        },
      ),
    createInstallmentPlan: (workspaceId, input, commandKey) =>
      call<
        FinanceAdapter["createInstallmentPlan"] extends (...args: never[]) => Promise<infer T>
          ? T
          : never
      >(`/workspaces/${workspaceId}/installments`, {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? idempotencyKey() },
        body: JSON.stringify(input),
      }),
    getInstallmentPlan: (workspaceId, planId) =>
      call<InstallmentPlan>(
        `/workspaces/${encodeURIComponent(workspaceId)}/installments/${encodeURIComponent(planId)}`,
      ),
    updateInstallmentPlan: (workspaceId, plan, input, commandKey) =>
      call<InstallmentPlan>(
        `/workspaces/${encodeURIComponent(workspaceId)}/installments/${encodeURIComponent(plan.id)}`,
        {
          method: "PATCH",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${plan.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
    updateInstallment: (workspaceId, plan, installment, input, commandKey) =>
      call<InstallmentPlan>(
        `/workspaces/${encodeURIComponent(workspaceId)}/installments/${encodeURIComponent(plan.id)}/${encodeURIComponent(installment.id)}`,
        {
          method: "PATCH",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${plan.version}"`,
          },
          body: JSON.stringify(input),
        },
      ),
    cancelFutureInstallments: (workspaceId, plan, commandKey) =>
      call<InstallmentPlan>(
        `/workspaces/${encodeURIComponent(workspaceId)}/installments/${encodeURIComponent(plan.id)}/cancel`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": commandKey ?? idempotencyKey(),
            "If-Match": `"v${plan.version}"`,
          },
          body: JSON.stringify({ confirm: true }),
        },
      ),
  };
}

const fixtureWorkspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
const fixtureCardId = "019b5d9e-3c12-7a10-8d47-7b5b5dd7a210";
const fixtureStatementId = "019b5d9e-3c12-7a11-8d47-7b5b5dd7a211";

function fixtureId(seed: number): string {
  return `019b5d9e-3c12-7a${String(seed).padStart(2, "0")}-8d47-7b5b5dd7a2${String(seed).padStart(2, "2")}`;
}

function fixtureHash(value: unknown): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}`.repeat(8);
}

/** Local-only data makes the shell usable before AUTH-002 supplies a session API. */
export function createFixtureFinanceAdapter(): FinanceAdapter {
  type FixtureWorkspaceState = {
    currency: string | null;
    walletVersion: number;
    walletAdjustmentDeltas: Map<string, bigint>;
    walletAdjustmentCommands: Map<string, { fingerprint: string; result: WalletAdjustmentResult }>;
    transactions: Transaction[];
    categories: Category[];
    cards: CreditCard[];
    statements: Statement[];
    transactionAudit: Map<string, FinanceAuditEvent[]>;
    transactionCommands: Map<string, { fingerprint: string; transaction: Transaction }>;
    reclassificationCommands: Map<
      string,
      {
        fingerprint: string;
        result: {
          committed: boolean;
          preview: TransactionReclassificationPreview;
          transactions: Transaction[];
        };
      }
    >;
    settlementCommands: Map<
      string,
      { transactionId: string; fingerprint: string; transaction: Transaction }
    >;
    statementPaymentCommands: Map<
      string,
      {
        fingerprint: string;
        response: { statementId: string; transactionId: string; amount: Money };
      }
    >;
    statementAdjustmentCommands: Map<
      string,
      { fingerprint: string; response: StatementAdjustmentResult }
    >;
    statementAdjustments: Map<
      string,
      {
        kind: "charge" | "fee" | "interest" | "refund";
        amount: bigint;
        sourceTransactionId: string | null;
      }
    >;
    recurrences: Map<string, { input: unknown; value: Recurrence }>;
    recurrenceCommands: Map<
      string,
      { fingerprint: string; value: { id: string; occurrences: string[] } }
    >;
    recurrenceEditCommands: Map<string, { fingerprint: string; value: RecurrenceEditResponse }>;
    recurrenceTransitionCommands: Map<string, { fingerprint: string; value: Recurrence }>;
    installmentPlans: Map<
      string,
      {
        input: unknown;
        value: InstallmentPlan;
      }
    >;
    installmentCommands: Map<
      string,
      {
        fingerprint: string;
        value: InstallmentPlan;
      }
    >;
    installmentEditCommands: Map<string, { fingerprint: string; value: InstallmentPlan }>;
    installmentCancelCommands: Map<string, { fingerprint: string; value: InstallmentPlan }>;
    reverseCommands: Map<
      string,
      { transactionId: string; fingerprint: string; transaction: Transaction }
    >;
  };
  const createWorkspaceState = (
    workspaceId: string,
    currency: string | null,
    withCard = false,
  ): FixtureWorkspaceState => {
    const cards: CreditCard[] = withCard
      ? [
          {
            id: fixtureCardId,
            workspaceId,
            name: "Cartão principal",
            closingDay: 10,
            dueDay: 17,
            holder: "Marina",
            lastFour: "4242",
            limit: { currency: currency ?? "USD", minor: "500000" },
            archived: false,
            version: 0,
          },
        ]
      : [];
    const statements: Statement[] = withCard
      ? [
          {
            id: fixtureStatementId,
            workspaceId,
            cardId: fixtureCardId,
            periodStart: "2026-08-11",
            closingOn: "2026-09-10",
            dueOn: "2026-09-17",
            state: "open",
            total: { currency: currency ?? "USD", minor: "0" },
            paid: { currency: currency ?? "USD", minor: "0" },
            openAmount: { currency: currency ?? "USD", minor: "0" },
            version: 0,
          },
        ]
      : [];
    return {
      currency,
      walletVersion: 0,
      walletAdjustmentDeltas: new Map(),
      walletAdjustmentCommands: new Map(),
      transactions: [],
      categories: [],
      cards,
      statements,
      transactionAudit: new Map(),
      transactionCommands: new Map(),
      reclassificationCommands: new Map(),
      settlementCommands: new Map(),
      statementPaymentCommands: new Map(),
      statementAdjustmentCommands: new Map(),
      statementAdjustments: new Map(),
      recurrences: new Map(),
      recurrenceCommands: new Map(),
      recurrenceEditCommands: new Map(),
      recurrenceTransitionCommands: new Map(),
      installmentPlans: new Map(),
      installmentCommands: new Map(),
      installmentEditCommands: new Map(),
      installmentCancelCommands: new Map(),
      reverseCommands: new Map(),
    };
  };
  const workspaceStates = new Map<string, FixtureWorkspaceState>([
    [fixtureWorkspaceId, createWorkspaceState(fixtureWorkspaceId, "BRL", true)],
    [
      "019b5d9e-3c12-7a02-8d47-7b5b5dd7a202",
      createWorkspaceState("019b5d9e-3c12-7a02-8d47-7b5b5dd7a202", "USD"),
    ],
  ]);
  const stateFor = (workspaceId: string): FixtureWorkspaceState => {
    const existing = workspaceStates.get(workspaceId);
    if (existing) return existing;
    const created = createWorkspaceState(workspaceId, null);
    workspaceStates.set(workspaceId, created);
    return created;
  };
  const fixtureWallet = (workspaceId: string): Wallet => {
    const state = stateFor(workspaceId);
    const transactionBalance = BigInt(walletTotalMinor(state.transactions));
    const adjustmentBalance = [...state.walletAdjustmentDeltas.values()].reduce(
      (total, delta) => total + delta,
      BigInt(0),
    );
    return {
      workspaceId,
      balance: {
        currency: state.currency ?? "BRL",
        minor: (transactionBalance + adjustmentBalance).toString(),
      },
      version: state.walletVersion,
    };
  };
  return {
    getWallet: async (workspaceId) => fixtureWallet(workspaceId),
    previewWalletAdjustment: async (workspaceId, observedBalance) => {
      const wallet = fixtureWallet(workspaceId);
      if (observedBalance.currency !== wallet.balance.currency) {
        throw new FinanceAdapterError("A moeda do saldo observado difere da carteira.", 409);
      }
      return {
        wallet,
        observedBalance,
        difference: {
          currency: wallet.balance.currency,
          minor: (BigInt(observedBalance.minor) - BigInt(wallet.balance.minor)).toString(),
        },
      };
    },
    adjustWallet: async (workspaceId, expectedWallet, input, commandKey) => {
      const state = stateFor(workspaceId);
      const fingerprint = JSON.stringify({ expectedWallet, input });
      if (commandKey) {
        const previous = state.walletAdjustmentCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro ajuste.", 409);
          }
          return previous.result;
        }
      }
      const wallet = fixtureWallet(workspaceId);
      if (wallet.version !== expectedWallet.version) {
        throw new FinanceAdapterError(
          "A carteira foi alterada. Confira o saldo novamente.",
          412,
          wallet.version,
        );
      }
      if (input.observedBalance.currency !== wallet.balance.currency) {
        throw new FinanceAdapterError("A moeda do saldo observado difere da carteira.", 409);
      }
      if (!input.reason.trim()) {
        throw new FinanceAdapterError("Informe o motivo do ajuste.", 422);
      }
      const difference = BigInt(input.observedBalance.minor) - BigInt(wallet.balance.minor);
      if (difference === BigInt(0)) {
        throw new FinanceAdapterError("O saldo observado já confere com a carteira.", 409);
      }
      const amount = difference < BigInt(0) ? -difference : difference;
      const transaction: Transaction = {
        id: fixtureId(state.transactions.length + 1),
        workspaceId,
        kind: "adjustment",
        state: "posted",
        amount: { currency: wallet.balance.currency, minor: amount.toString() },
        settledAmount: { currency: wallet.balance.currency, minor: amount.toString() },
        occurredOn: new Date().toISOString().slice(0, 10),
        dueOn: null,
        postedOn: new Date().toISOString(),
        description: "Ajuste de saldo",
        categoryId: null,
        cardId: null,
        statementId: null,
        version: 0,
      };
      state.transactions.unshift(transaction);
      state.walletAdjustmentDeltas.set(transaction.id, difference);
      state.walletVersion += 1;
      const result: WalletAdjustmentResult = {
        wallet: fixtureWallet(workspaceId),
        observedBalance: input.observedBalance,
        difference: { currency: wallet.balance.currency, minor: difference.toString() },
        transaction,
      };
      const event: FinanceAuditEvent = {
        id: fixtureId(80 + state.transactionAudit.size),
        transactionId: transaction.id,
        category: "finance",
        action: "wallet.adjusted",
        actorId: "fixture-user",
        occurredAt: new Date().toISOString(),
        origin: "fixture",
        correlationId: "fixture-correlation",
        result: "success",
        reason: input.reason.trim(),
        before: {
          kind: "adjustment",
          state: "posted",
          version: transaction.version,
          walletVersion: expectedWallet.version,
        },
        after: {
          kind: "adjustment",
          state: "posted",
          version: transaction.version,
          walletVersion: state.walletVersion,
        },
      };
      state.transactionAudit.set(transaction.id, [event]);
      if (commandKey) state.walletAdjustmentCommands.set(commandKey, { fingerprint, result });
      return result;
    },
    listTransactions: async (workspaceId, query = {}) => {
      const state = stateFor(workspaceId);
      const filtered = state.transactions.filter((transaction) => {
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
    getTransaction: async (workspaceId, transactionId) => {
      const transaction = stateFor(workspaceId).transactions.find(
        (item) => item.id === transactionId,
      );
      if (!transaction) throw new FinanceAdapterError("Lançamento não encontrado.", 404);
      return transaction;
    },
    createTransaction: async (workspaceId, input, commandKey) => {
      const state = stateFor(workspaceId);
      const fingerprint = JSON.stringify(input);
      if (commandKey) {
        const previous = state.transactionCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro lançamento.", 409);
          }
          return previous.transaction;
        }
      }
      if (!state.currency) state.currency = input.amount.currency;
      if (state.currency !== input.amount.currency) {
        throw new FinanceAdapterError("A moeda não corresponde à moeda do espaço.", 422);
      }
      if (input.cardId && !state.cards.some((card) => card.id === input.cardId)) {
        throw new FinanceAdapterError("Cartão não encontrado neste espaço.", 404);
      }
      const value: Transaction = {
        id: fixtureId(state.transactions.length + 1),
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
      state.transactions.unshift(value);
      const event: FinanceAuditEvent = {
        id: fixtureId(50 + state.transactionAudit.size),
        transactionId: value.id,
        category: "finance",
        action: "transaction.created",
        actorId: "fixture-user",
        occurredAt: new Date().toISOString(),
        origin: "fixture",
        correlationId: "fixture-correlation",
        result: "success",
        reason: null,
        before: null,
        after: {
          kind: value.kind,
          state: value.state,
          categoryId: value.categoryId,
          cardId: value.cardId,
          statementId: value.statementId,
          version: value.version,
        },
      };
      state.transactionAudit.set(value.id, [event]);
      if (input.cardId) {
        const statement = state.statements.find(
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
      event.after = { ...event.after, statementId: value.statementId };
      if (commandKey)
        state.transactionCommands.set(commandKey, { fingerprint, transaction: value });
      return value;
    },
    postTransaction: async (workspaceId, transaction, input = {}, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.transactions.find((value) => value.id === transaction.id);
      if (!current) throw new FinanceAdapterError("Compromisso não encontrado.", 404);
      const fingerprint = JSON.stringify({ transactionId: transaction.id, input });
      if (commandKey) {
        const previous = state.settlementCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outra liquidação.", 409);
          }
          return previous.transaction;
        }
      }
      if (current.version !== transaction.version) {
        throw new FinanceAdapterError(
          "O compromisso foi alterado por outra pessoa.",
          412,
          current.version,
        );
      }
      if (current.state !== "planned" && current.state !== "partially_settled") {
        throw new FinanceAdapterError("O compromisso não está pendente.", 409);
      }
      const remaining = BigInt(current.amount.minor) - BigInt(current.settledAmount.minor);
      const amount = input.amount ? BigInt(input.amount.minor) : remaining;
      if (!input.amount && remaining <= BigInt(0)) {
        throw new FinanceAdapterError("O compromisso já foi liquidado.", 409);
      }
      if (input.amount && input.amount.currency !== current.amount.currency) {
        throw new FinanceAdapterError("A moeda da liquidação não corresponde ao espaço.", 422);
      }
      if (amount <= BigInt(0) || amount > remaining) {
        throw new FinanceAdapterError(
          "A liquidação deve estar entre zero e o saldo restante.",
          422,
        );
      }
      const settledMinor = BigInt(current.settledAmount.minor) + amount;
      const value: Transaction = {
        ...current,
        settledAmount: { ...current.settledAmount, minor: settledMinor.toString() },
        state: settledMinor === BigInt(current.amount.minor) ? "posted" : "partially_settled",
        occurredOn: input.occurredOn ?? current.occurredOn,
        postedOn: new Date().toISOString(),
        version: current.version + 1,
      };
      state.transactions[state.transactions.indexOf(current)] = value;
      const events = state.transactionAudit.get(value.id) ?? [];
      events.unshift({
        id: fixtureId(50 + state.transactionAudit.size + events.length),
        transactionId: value.id,
        category: "finance",
        action: value.state === "posted" ? "transaction.posted" : "transaction.partially_settled",
        actorId: "fixture-user",
        occurredAt: new Date().toISOString(),
        origin: "fixture",
        correlationId: "fixture-correlation",
        result: "success",
        reason: null,
        before: {
          state: current.state,
          settledAmount: current.settledAmount,
          version: current.version,
        },
        after: { state: value.state, settledAmount: value.settledAmount, version: value.version },
      });
      state.transactionAudit.set(value.id, events);
      if (commandKey) {
        state.settlementCommands.set(commandKey, {
          transactionId: value.id,
          fingerprint,
          transaction: value,
        });
      }
      return value;
    },
    reverseTransaction: async (workspaceId, transaction, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.transactions.find((value) => value.id === transaction.id);
      if (!current) throw new FinanceAdapterError("Lançamento não encontrado.", 404);
      const fingerprint = `${transaction.id}:v${transaction.version}`;
      if (commandKey) {
        const previous = state.reverseCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outra reversão.", 409);
          }
          return previous.transaction;
        }
      }
      if (state.statementAdjustments.has(current.id)) {
        throw new FinanceAdapterError(
          "Este lançamento é um ajuste da fatura; abra a fatura e registre a correção correspondente.",
          409,
        );
      }
      if (current.state === "canceled") return current;
      const value = { ...current, state: "canceled" as const, version: current.version + 1 };
      state.transactions[state.transactions.indexOf(current)] = value;
      const events = state.transactionAudit.get(value.id) ?? [];
      events.unshift({
        id: fixtureId(50 + state.transactionAudit.size + events.length),
        transactionId: value.id,
        category: "finance",
        action: "transaction.reversed",
        actorId: "fixture-user",
        occurredAt: new Date().toISOString(),
        origin: "fixture",
        correlationId: "fixture-correlation",
        result: "success",
        reason: null,
        before: { state: current.state, version: current.version },
        after: { state: value.state, version: value.version },
      });
      state.transactionAudit.set(value.id, events);
      if (value.statementId && value.kind === "expense") {
        const statement = state.statements.find((item) => item.id === value.statementId);
        if (statement) {
          const total = BigInt(statement.total.minor) - BigInt(value.amount.minor);
          const openAmount = total - BigInt(statement.paid.minor);
          statement.total = { ...statement.total, minor: total.toString() };
          statement.openAmount = {
            ...statement.openAmount,
            minor: (openAmount > BigInt(0) ? openAmount : BigInt(0)).toString(),
          };
        }
      }
      if (commandKey) {
        state.reverseCommands.set(commandKey, {
          transactionId: value.id,
          fingerprint,
          transaction: value,
        });
      }
      return value;
    },
    listTransactionAudit: async (workspaceId, transactionId, query = {}) => {
      const all = stateFor(workspaceId).transactionAudit.get(transactionId) ?? [];
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const offset = query.cursor?.startsWith("fixture:")
        ? Number.parseInt(query.cursor.slice("fixture:".length), 10)
        : 0;
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const items = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return { items, nextCursor: hasMore ? `fixture:${start + limit}` : null, hasMore };
    },
    getTransactionAudit: async (workspaceId, transactionId, auditId) => {
      const event = (stateFor(workspaceId).transactionAudit.get(transactionId) ?? []).find(
        (item) => item.id === auditId,
      );
      if (!event) throw new FinanceAdapterError("Evento de auditoria não encontrado.", 404);
      return { ...event, consequences: { ledgerEvents: [] } };
    },
    listCategories: async (workspaceId) => [...stateFor(workspaceId).categories],
    createCategory: async (workspaceId, input) => {
      const state = stateFor(workspaceId);
      const categories = state.categories;
      const category: Category = {
        id: fixtureId(120 + categories.length),
        workspaceId,
        name: input.name,
        kind: input.kind,
        archived: false,
        version: 0,
      };
      categories.push(category);
      return category;
    },
    updateCategory: async (workspaceId, category, input) => {
      const state = stateFor(workspaceId);
      const next = { ...category, ...input, version: category.version + 1 };
      const index = state.categories.findIndex((value) => value.id === category.id);
      if (index >= 0) state.categories[index] = next;
      return next;
    },
    archiveCategory: async (workspaceId, category) => {
      const state = stateFor(workspaceId);
      const next = { ...category, archived: true, version: category.version + 1 };
      const index = state.categories.findIndex((value) => value.id === category.id);
      if (index >= 0) state.categories[index] = next;
      return next;
    },
    restoreCategory: async (workspaceId, category) => {
      const state = stateFor(workspaceId);
      const next = { ...category, archived: false, version: category.version + 1 };
      const index = state.categories.findIndex((value) => value.id === category.id);
      if (index >= 0) state.categories[index] = next;
      return next;
    },
    previewTransactionReclassification: async (workspaceId, input) => {
      const state = stateFor(workspaceId);
      const category = state.categories.find((value) => value.id === input.categoryId);
      if (!category) throw new FinanceAdapterError("Categoria não encontrada.", 404);
      const rows = input.transactions.map((selection) => {
        const transaction = state.transactions.find((value) => value.id === selection.id);
        const errors: string[] = [];
        if (!transaction) errors.push("A transação não foi encontrada neste espaço.");
        else {
          if (transaction.version !== selection.version)
            errors.push("A transação foi alterada desde a prévia.");
          if (category.archived) errors.push("A categoria está arquivada.");
          if (transaction.kind !== category.kind && category.kind !== "both")
            errors.push("A categoria não é compatível com o tipo da transação.");
          if (
            transaction.state === "canceled" ||
            transaction.kind === "transfer" ||
            transaction.kind === "adjustment"
          )
            errors.push("A transação não pode ser reclassificada.");
          if (transaction.cardId || transaction.statementId)
            errors.push("Compras de cartão devem ser editadas pela fatura.");
          if (transaction.categoryId === category.id)
            errors.push("A transação já usa esta categoria.");
        }
        return {
          transactionId: selection.id,
          currentCategoryId: transaction?.categoryId ?? null,
          categoryId: input.categoryId,
          version: transaction?.version ?? selection.version,
          status: errors.length ? ("invalid" as const) : ("ready" as const),
          errors,
        };
      });
      return {
        categoryId: category.id,
        categoryVersion: category.version,
        previewHash: fixtureHash({
          categoryId: category.id,
          categoryVersion: category.version,
          rows,
        }),
        rows,
        canConfirm: rows.every((row) => row.status === "ready"),
      };
    },
    reclassifyTransactions: async (workspaceId, input, preview, commandKey) => {
      const state = stateFor(workspaceId);
      const fingerprint = JSON.stringify({ input, preview });
      if (commandKey) {
        const previous = state.reclassificationCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outra reclassificação.", 409);
          return previous.result;
        }
      }
      const freshRows = input.transactions.map((selection) =>
        state.transactions.find((value) => value.id === selection.id),
      );
      if (!preview.canConfirm || freshRows.some((transaction) => !transaction)) {
        throw new FinanceAdapterError(
          "A prévia contém transações que não podem ser reclassificadas.",
          422,
        );
      }
      const completeRows = freshRows.filter(
        (transaction): transaction is Transaction => !!transaction,
      );
      for (const selection of input.transactions) {
        const current = state.transactions.find((transaction) => transaction.id === selection.id);
        if (!current || current.version !== selection.version) {
          throw new FinanceAdapterError(
            "A transação foi alterada. Gere uma nova prévia.",
            412,
            current?.version,
          );
        }
      }
      const category = state.categories.find((value) => value.id === input.categoryId);
      if (!category || category.version !== preview.categoryVersion)
        throw new FinanceAdapterError(
          "A categoria foi alterada. Gere uma nova prévia.",
          412,
          category?.version,
        );
      const updated = completeRows.map((transaction) => ({
        ...transaction,
        categoryId: input.categoryId,
        version: transaction.version + 1,
      }));
      for (const transaction of updated) {
        const index = state.transactions.findIndex((value) => value.id === transaction.id);
        state.transactions[index] = transaction;
        const audit = state.transactionAudit.get(transaction.id) ?? [];
        audit.unshift({
          id: fixtureId(800 + audit.length),
          transactionId: transaction.id,
          category: "finance",
          action: "transaction.reclassified",
          actorId: "fixture-user",
          occurredAt: new Date().toISOString(),
          origin: "api",
          correlationId: "fixture-correlation",
          result: "success",
          reason: null,
          before: {
            kind: transaction.kind,
            state: transaction.state,
            categoryId:
              preview.rows.find((row) => row.transactionId === transaction.id)?.currentCategoryId ??
              null,
            version: transaction.version - 1,
          },
          after: {
            kind: transaction.kind,
            state: transaction.state,
            categoryId: transaction.categoryId,
            version: transaction.version,
          },
        });
        state.transactionAudit.set(transaction.id, audit);
      }
      const result = { committed: true, preview, transactions: updated };
      if (commandKey) state.reclassificationCommands.set(commandKey, { fingerprint, result });
      return result;
    },
    listCards: async (workspaceId) => [...stateFor(workspaceId).cards],
    createCard: async (workspaceId, input) => {
      const state = stateFor(workspaceId);
      const card: CreditCard = {
        id: fixtureId(state.cards.length + 10),
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
      state.cards.push(card);
      return card;
    },
    updateCard: async (workspaceId, card, input) => {
      const state = stateFor(workspaceId);
      const current = state.cards.find((item) => item.id === card.id);
      if (!current) throw new FinanceAdapterError("Cartão não encontrado.", 404);
      if (current.version !== card.version) {
        throw new FinanceAdapterError(
          "O cartão foi alterado por outra pessoa.",
          412,
          current.version,
        );
      }
      if (input.closingDay !== undefined && (input.closingDay < 1 || input.closingDay > 31)) {
        throw new FinanceAdapterError("O fechamento deve estar entre 1 e 31.", 422);
      }
      if (input.dueDay !== undefined && (input.dueDay < 1 || input.dueDay > 31)) {
        throw new FinanceAdapterError("O vencimento deve estar entre 1 e 31.", 422);
      }
      const value: CreditCard = {
        ...current,
        ...input,
        holder: input.holder === undefined ? current.holder : input.holder,
        lastFour: input.lastFour === undefined ? current.lastFour : input.lastFour,
        limit: input.limit === undefined ? current.limit : input.limit,
        version: current.version + 1,
      };
      state.cards[state.cards.indexOf(current)] = value;
      return value;
    },
    archiveCard: async (workspaceId, card) => {
      const state = stateFor(workspaceId);
      const current = state.cards.find((item) => item.id === card.id);
      if (!current) throw new FinanceAdapterError("Cartão não encontrado.", 404);
      if (current.version !== card.version) {
        throw new FinanceAdapterError(
          "O cartão foi alterado por outra pessoa.",
          412,
          current.version,
        );
      }
      const hasOpenBalance = state.statements.some(
        (statement) =>
          statement.cardId === current.id &&
          statement.state !== "canceled" &&
          (statement.state === "open" || BigInt(statement.openAmount.minor) > BigInt(0)),
      );
      if (hasOpenBalance) {
        throw new FinanceAdapterError(
          "Quite o saldo e feche ou transfira a fatura antes de arquivar o cartão.",
          409,
        );
      }
      const value = { ...current, archived: true, version: current.version + 1 };
      state.cards[state.cards.indexOf(current)] = value;
      return value;
    },
    listStatements: async (workspaceId, cardId) =>
      stateFor(workspaceId).statements.filter(
        (statement) => !cardId || statement.cardId === cardId,
      ),
    getStatement: async (workspaceId, statementId) => {
      const statement = stateFor(workspaceId).statements.find((item) => item.id === statementId);
      if (!statement) throw new FinanceAdapterError("Fatura não encontrada.", 404);
      return statement;
    },
    listStatementItems: async (workspaceId, statementId, query = {}) => {
      const state = stateFor(workspaceId);
      const allItems = state.transactions
        .filter((transaction) => transaction.statementId === statementId)
        .map((transaction) => ({
          id: transaction.id,
          transactionId: transaction.id,
          statementId,
          type:
            transaction.kind === "transfer"
              ? ("payment" as const)
              : state.statementAdjustments.get(transaction.id)?.kind === "refund"
                ? ("refund" as const)
                : state.statementAdjustments.has(transaction.id)
                  ? ("adjustment" as const)
                  : ("purchase" as const),
          state: transaction.state,
          description: transaction.description,
          occurredOn: transaction.occurredOn,
          amount: state.statementAdjustments.has(transaction.id)
            ? {
                ...transaction.amount,
                minor:
                  state.statementAdjustments.get(transaction.id)?.amount.toString() ??
                  transaction.amount.minor,
              }
            : transaction.amount,
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
    closeStatement: async (workspaceId, statement) => {
      const state = stateFor(workspaceId);
      const value = { ...statement, state: "closed" as const, version: statement.version + 1 };
      const index = state.statements.findIndex(({ id }) => id === statement.id);
      if (index >= 0) state.statements[index] = value;
      return value;
    },
    reopenStatement: async (workspaceId, statement) => {
      const state = stateFor(workspaceId);
      if (statement.state !== "closed" || BigInt(statement.paid.minor) > BigInt(0)) {
        throw new FinanceAdapterError(
          "Apenas faturas fechadas e sem pagamentos podem ser reabertas.",
          409,
        );
      }
      const value = { ...statement, state: "open" as const, version: statement.version + 1 };
      const index = state.statements.findIndex(({ id }) => id === statement.id);
      if (index >= 0) state.statements[index] = value;
      return value;
    },
    payStatement: async (workspaceId, statement, amount, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.statements.find(({ id }) => id === statement.id);
      if (!current) throw new FinanceAdapterError("Fatura não encontrada.", 404);
      const fingerprint = JSON.stringify({ statementId: statement.id, amount });
      if (commandKey) {
        const previous = state.statementPaymentCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro pagamento.", 409);
          }
          return previous.response;
        }
      }
      const paid = amount ?? current.openAmount;
      if (paid.currency !== current.openAmount.currency) {
        throw new FinanceAdapterError("A moeda do pagamento não corresponde à fatura.", 422);
      }
      const open = BigInt(current.openAmount.minor);
      const paidMinor = BigInt(paid.minor);
      if (paidMinor <= BigInt(0) || paidMinor > open) {
        throw new FinanceAdapterError("O pagamento excede o valor em aberto.", 422);
      }
      const nextPaid = BigInt(current.paid.minor) + paidMinor;
      const nextOpen = BigInt(current.total.minor) - nextPaid;
      const transaction: Transaction = {
        id: fixtureId(80 + state.transactions.length),
        workspaceId,
        kind: "transfer",
        state: "posted",
        amount: { ...paid, minor: paidMinor.toString() },
        settledAmount: { ...paid, minor: paidMinor.toString() },
        occurredOn: new Date().toISOString().slice(0, 10),
        dueOn: null,
        postedOn: new Date().toISOString(),
        description: "Pagamento de fatura",
        categoryId: null,
        cardId: null,
        statementId: current.id,
        version: 0,
      };
      state.transactions.unshift(transaction);
      state.transactionAudit.set(transaction.id, [
        {
          id: fixtureId(150 + state.transactionAudit.size),
          transactionId: transaction.id,
          category: "finance",
          action: "transaction.created",
          actorId: "fixture-user",
          occurredAt: new Date().toISOString(),
          origin: "fixture",
          correlationId: "fixture-correlation",
          result: "success",
          reason: null,
          before: null,
          after: {
            kind: transaction.kind,
            state: transaction.state,
            statementId: transaction.statementId,
            settledAmount: transaction.settledAmount,
            version: transaction.version,
          },
        },
      ]);
      const response = {
        statementId: current.id,
        transactionId: transaction.id,
        amount: transaction.amount,
      };
      state.statements[state.statements.indexOf(current)] = {
        ...current,
        paid: { ...current.paid, minor: nextPaid.toString() },
        openAmount: { ...current.openAmount, minor: nextOpen.toString() },
        state: nextOpen <= BigInt(0) ? "paid" : "partially_paid",
        version: current.version + 1,
      };
      if (commandKey) state.statementPaymentCommands.set(commandKey, { fingerprint, response });
      return response;
    },
    createStatementAdjustment: async (workspaceId, statement, input, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.statements.find(({ id }) => id === statement.id);
      if (!current) throw new FinanceAdapterError("Fatura não encontrada.", 404);
      const fingerprint = JSON.stringify({ statementId: statement.id, input });
      if (commandKey) {
        const previous = state.statementAdjustmentCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro ajuste.", 409);
          }
          return previous.response;
        }
      }
      if (current.version !== statement.version) {
        throw new FinanceAdapterError(
          "A fatura foi alterada por outra pessoa.",
          412,
          current.version,
        );
      }
      if (input.amount.currency !== current.total.currency) {
        throw new FinanceAdapterError("A moeda do ajuste não corresponde à fatura.", 422);
      }
      const amountMinor = BigInt(input.amount.minor);
      if (amountMinor <= BigInt(0))
        throw new FinanceAdapterError("O ajuste deve ser positivo.", 422);
      const transaction: Transaction = {
        id: fixtureId(180 + state.transactions.length),
        workspaceId,
        kind: "expense",
        state: "posted",
        amount: { ...input.amount, minor: amountMinor.toString() },
        settledAmount: { ...input.amount, minor: amountMinor.toString() },
        occurredOn: input.occurredOn ?? new Date().toISOString().slice(0, 10),
        dueOn: null,
        postedOn: new Date().toISOString(),
        description: input.description,
        categoryId: null,
        cardId: current.cardId,
        statementId: current.id,
        version: 0,
      };
      state.transactions.unshift(transaction);
      state.statementAdjustments.set(transaction.id, {
        kind: input.kind,
        amount: amountMinor,
        sourceTransactionId: null,
      });
      const nextTotal = BigInt(current.total.minor) + amountMinor;
      const nextOpen = nextTotal - BigInt(current.paid.minor);
      const nextState =
        current.state === "open"
          ? "open"
          : nextOpen <= BigInt(0)
            ? "paid"
            : BigInt(current.paid.minor) > BigInt(0)
              ? "partially_paid"
              : "closed";
      const nextStatement = {
        ...current,
        total: { ...current.total, minor: nextTotal.toString() },
        openAmount: { ...current.openAmount, minor: nextOpen.toString() },
        state: nextState as Statement["state"],
        version: current.version + 1,
      };
      state.statements[state.statements.indexOf(current)] = nextStatement;
      const response = { transaction, statement: nextStatement };
      if (commandKey) state.statementAdjustmentCommands.set(commandKey, { fingerprint, response });
      return response;
    },
    createStatementRefund: async (workspaceId, statement, input, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.statements.find(({ id }) => id === statement.id);
      if (!current) throw new FinanceAdapterError("Fatura não encontrada.", 404);
      const fingerprint = JSON.stringify({ statementId: statement.id, input });
      if (commandKey) {
        const previous = state.statementAdjustmentCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro estorno.", 409);
          }
          return previous.response;
        }
      }
      if (current.version !== statement.version) {
        throw new FinanceAdapterError(
          "A fatura foi alterada por outra pessoa.",
          412,
          current.version,
        );
      }
      const source = state.transactions.find((item) => item.id === input.sourceTransactionId);
      if (
        !source ||
        state.statementAdjustments.has(source.id) ||
        source.cardId !== current.cardId ||
        source.kind !== "expense" ||
        (source.state !== "posted" && source.state !== "partially_settled")
      ) {
        throw new FinanceAdapterError("A compra original não pertence a este cartão.", 409);
      }
      const previousRefunds = [...state.statementAdjustments.entries()]
        .filter(
          ([, adjustment]) =>
            adjustment.kind === "refund" && adjustment.sourceTransactionId === source.id,
        )
        .reduce((total, [, adjustment]) => total + -adjustment.amount, BigInt(0));
      if (BigInt(input.amount.minor) > BigInt(source.settledAmount.minor) - previousRefunds) {
        throw new FinanceAdapterError("O estorno excede o saldo da compra.", 409);
      }
      if (input.amount.currency !== current.total.currency) {
        throw new FinanceAdapterError("A moeda do estorno não corresponde à fatura.", 422);
      }
      const amountMinor = BigInt(input.amount.minor);
      const nextTotal = BigInt(current.total.minor) - amountMinor;
      if (amountMinor <= BigInt(0) || nextTotal < BigInt(0)) {
        throw new FinanceAdapterError("O estorno deve manter o total da fatura não negativo.", 422);
      }
      const description =
        input.description?.trim() || `Estorno: ${source.description || "compra no cartão"}`;
      const transaction: Transaction = {
        id: fixtureId(200 + state.transactions.length),
        workspaceId,
        kind: "expense",
        state: "posted",
        amount: { ...input.amount, minor: amountMinor.toString() },
        settledAmount: { ...input.amount, minor: amountMinor.toString() },
        occurredOn: input.occurredOn ?? new Date().toISOString().slice(0, 10),
        dueOn: null,
        postedOn: new Date().toISOString(),
        description,
        categoryId: null,
        cardId: current.cardId,
        statementId: current.id,
        version: 0,
      };
      state.transactions.unshift(transaction);
      state.statementAdjustments.set(transaction.id, {
        kind: "refund",
        amount: -amountMinor,
        sourceTransactionId: source.id,
      });
      const nextOpen = nextTotal - BigInt(current.paid.minor);
      const nextState =
        current.state === "open"
          ? "open"
          : nextOpen <= BigInt(0)
            ? "paid"
            : BigInt(current.paid.minor) > BigInt(0)
              ? "partially_paid"
              : "closed";
      const nextStatement = {
        ...current,
        total: { ...current.total, minor: nextTotal.toString() },
        openAmount: { ...current.openAmount, minor: nextOpen.toString() },
        state: nextState as Statement["state"],
        version: current.version + 1,
      };
      state.statements[state.statements.indexOf(current)] = nextStatement;
      const response = { transaction, statement: nextStatement };
      if (commandKey) state.statementAdjustmentCommands.set(commandKey, { fingerprint, response });
      return response;
    },
    createRecurrence: async (workspaceId, input, commandKey) => {
      const state = stateFor(workspaceId);
      const fingerprint = JSON.stringify(input);
      if (commandKey) {
        const previous = state.recurrenceCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outra recorrência.", 409);
          }
          return previous.value;
        }
      }
      const id = fixtureId(90 + state.recurrences.size);
      const value: Recurrence = {
        id,
        workspaceId,
        kind: input.kind,
        amount: input.amount,
        frequency: input.frequency,
        interval: input.interval,
        startOn: input.startOn,
        endOn: input.endOn ?? null,
        maxOccurrences: input.maxOccurrences ?? null,
        variable: input.variable,
        estimatedAmount: input.estimatedAmount ?? null,
        description: input.description ?? "",
        pausedOn: null,
        version: 0,
      };
      const created = { id, occurrences: [] };
      state.recurrences.set(id, { input, value });
      if (commandKey) state.recurrenceCommands.set(commandKey, { fingerprint, value: created });
      return created;
    },
    getRecurrence: async (workspaceId, recurrenceId) => {
      const value = stateFor(workspaceId).recurrences.get(recurrenceId)?.value;
      if (!value) throw new FinanceAdapterError("Recorrência não encontrada.", 404);
      return value;
    },
    updateRecurrence: async (workspaceId, recurrence, input, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.recurrences.get(recurrence.id)?.value;
      if (!current) throw new FinanceAdapterError("Recorrência não encontrada.", 404);
      if (input.scope !== "this_and_future") {
        throw new FinanceAdapterError(
          "Este escopo exige ocorrências materializadas e só está disponível no servidor.",
          422,
        );
      }
      const fingerprint = JSON.stringify({ recurrenceId: recurrence.id, input });
      if (commandKey) {
        const previous = state.recurrenceEditCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outra recorrência.", 409);
          return previous.value;
        }
      }
      if (current.version !== recurrence.version)
        throw new FinanceAdapterError(
          "A recorrência foi alterada por outra pessoa.",
          412,
          current.version,
        );
      const next: Recurrence = {
        ...current,
        amount: input.amount ?? current.amount,
        description: input.description ?? current.description,
        endOn: input.endOn === undefined ? current.endOn : input.endOn,
        estimatedAmount:
          input.estimatedAmount === undefined ? current.estimatedAmount : input.estimatedAmount,
        version: current.version + 1,
      };
      state.recurrences.set(next.id, { input: current, value: next });
      const response = { recurrence: next, affectedOccurrences: [input.effectiveOn] };
      if (commandKey)
        state.recurrenceEditCommands.set(commandKey, {
          fingerprint,
          value: response,
        });
      return response;
    },
    transitionRecurrence: async (workspaceId, recurrence, action, effectiveOn, _commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.recurrences.get(recurrence.id)?.value;
      const fingerprint = JSON.stringify({ recurrenceId: recurrence.id, action, effectiveOn });
      if (!current) throw new FinanceAdapterError("Recorrência não encontrada.", 404);
      if (_commandKey) {
        const previous = state.recurrenceTransitionCommands.get(_commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outra transição.", 409);
          return previous.value;
        }
      }
      if (current.version !== recurrence.version)
        throw new FinanceAdapterError(
          "A recorrência foi alterada por outra pessoa.",
          412,
          current.version,
        );
      const next: Recurrence = {
        ...current,
        pausedOn:
          action === "pause" ? (effectiveOn ?? new Date().toISOString().slice(0, 10)) : null,
        version: current.version + 1,
      };
      state.recurrences.set(next.id, { input: current, value: next });
      if (_commandKey)
        state.recurrenceTransitionCommands.set(_commandKey, {
          fingerprint,
          value: next,
        });
      return next;
    },
    createInstallmentPlan: async (workspaceId, input, commandKey) => {
      const state = stateFor(workspaceId);
      const fingerprint = JSON.stringify(input);
      if (commandKey) {
        const previous = state.installmentCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new FinanceAdapterError("A chave já foi usada para outro parcelamento.", 409);
          }
          return previous.value;
        }
      }
      const amounts = previewInstallmentMinor(input.total.minor, input.count);
      const dates = previewInstallmentDates(input.firstDueOn, input.count);
      if (amounts.length === 0 || dates.length !== amounts.length) {
        throw new FinanceAdapterError("O parcelamento não é válido.", 422);
      }
      const value: InstallmentPlan = {
        id: fixtureId(91 + state.installmentPlans.size),
        workspaceId,
        total: input.total,
        count: input.count,
        firstDueOn: input.firstDueOn,
        version: 0,
        installments: amounts.map((minor, index) => ({
          id: fixtureId(110 + state.installmentPlans.size * input.count + index),
          number: index + 1,
          amount: { ...input.total, minor },
          dueOn: dates[index] as string,
          transactionId: fixtureId(300 + state.installmentPlans.size * input.count + index),
          state: "planned",
          version: 0,
        })),
      };
      state.installmentPlans.set(value.id, { input, value });
      if (commandKey) state.installmentCommands.set(commandKey, { fingerprint, value });
      return value;
    },
    getInstallmentPlan: async (workspaceId, planId) => {
      const value = stateFor(workspaceId).installmentPlans.get(planId)?.value;
      if (!value) throw new FinanceAdapterError("Parcelamento não encontrado.", 404);
      return value;
    },
    updateInstallmentPlan: async (workspaceId, plan, input, _commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.installmentPlans.get(plan.id)?.value;
      if (!current) throw new FinanceAdapterError("Parcelamento não encontrado.", 404);
      const fingerprint = JSON.stringify({ planId: plan.id, expectedVersion: plan.version, input });
      if (_commandKey) {
        const previous = state.installmentEditCommands.get(_commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outro parcelamento.", 409);
          return previous.value;
        }
      }
      if (current.version !== plan.version)
        throw new FinanceAdapterError(
          "O parcelamento foi alterado por outra pessoa.",
          412,
          current.version,
        );
      const nextCount = input.count ?? current.count;
      const nextTotal = input.total ?? current.total;
      const realized = current.installments.filter(
        (item) => item.state === "posted" || item.state === "partially_settled",
      );
      if (nextCount < realized.length)
        throw new FinanceAdapterError("Não é possível remover parcelas realizadas.", 409);
      const realizedTotal = realized.reduce(
        (sum, item) => sum + BigInt(item.amount.minor),
        BigInt(0),
      );
      const futureCount = nextCount - realized.length;
      const remaining = BigInt(nextTotal.minor) - realizedTotal;
      if (futureCount < 1 || remaining <= BigInt(0))
        throw new FinanceAdapterError("O total precisa manter saldo futuro positivo.", 409);
      const amounts = previewInstallmentMinor(remaining.toString(), futureCount);
      const dates = previewInstallmentDates(input.firstDueOn ?? current.firstDueOn, nextCount);
      if (!amounts.length || dates.length !== nextCount)
        throw new FinanceAdapterError("O parcelamento não é válido.", 422);
      const next: InstallmentPlan = {
        ...current,
        total: nextTotal,
        count: nextCount,
        firstDueOn: input.firstDueOn ?? current.firstDueOn,
        version: current.version + 1,
        installments: (() => {
          let futureIndex = 0;
          return Array.from({ length: nextCount }, (_, index) => {
            const existing = current.installments[index];
            if (existing && (existing.state === "posted" || existing.state === "partially_settled"))
              return existing;
            const value = {
              ...(existing ?? {
                id: fixtureId(400 + index),
                transactionId: fixtureId(500 + index),
                state: "planned",
                version: 0,
              }),
              number: index + 1,
              amount: { ...nextTotal, minor: amounts[futureIndex] as string },
              dueOn: dates[index] as string,
            };
            futureIndex += 1;
            return value;
          });
        })(),
      };
      state.installmentPlans.set(plan.id, { input: current, value: next });
      if (_commandKey)
        state.installmentEditCommands.set(_commandKey, {
          fingerprint,
          value: next,
        });
      return next;
    },
    updateInstallment: async (workspaceId, plan, installment, input, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.installmentPlans.get(plan.id)?.value;
      if (!current) throw new FinanceAdapterError("Parcelamento não encontrado.", 404);
      const fingerprint = JSON.stringify({
        planId: plan.id,
        installmentId: installment.id,
        expectedVersion: plan.version,
        input,
      });
      if (commandKey) {
        const previous = state.installmentEditCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outra parcela.", 409);
          return previous.value;
        }
      }
      if (current.version !== plan.version)
        throw new FinanceAdapterError(
          "O parcelamento foi alterado por outra pessoa.",
          412,
          current.version,
        );
      const target = current.installments.find((item) => item.id === installment.id);
      if (target?.state !== "planned")
        throw new FinanceAdapterError("Somente parcelas futuras podem ser alteradas.", 409);
      const next: InstallmentPlan = {
        ...current,
        version: current.version + 1,
        installments: current.installments.map((item) =>
          item.id === installment.id
            ? {
                ...item,
                amount: input.amount ?? item.amount,
                dueOn: input.dueOn ?? item.dueOn,
                version: item.version + 1,
              }
            : item,
        ),
      };
      const oldMinor = BigInt(target.amount.minor);
      const newMinor = BigInt((input.amount ?? target.amount).minor);
      const companion = next.installments.find(
        (item) => item.id !== target.id && item.state === "planned",
      );
      if (
        oldMinor !== newMinor &&
        (!companion || BigInt(companion.amount.minor) + oldMinor - newMinor <= BigInt(0))
      ) {
        throw new FinanceAdapterError(
          "É preciso conservar um valor positivo em outra parcela futura.",
          409,
        );
      }
      if (oldMinor !== newMinor && companion) {
        companion.amount = {
          ...companion.amount,
          minor: (BigInt(companion.amount.minor) + oldMinor - newMinor).toString(),
        };
      }
      state.installmentPlans.set(plan.id, { input: current, value: next });
      if (commandKey) state.installmentEditCommands.set(commandKey, { fingerprint, value: next });
      return next;
    },
    cancelFutureInstallments: async (workspaceId, plan, commandKey) => {
      const state = stateFor(workspaceId);
      const current = state.installmentPlans.get(plan.id)?.value;
      if (!current) throw new FinanceAdapterError("Parcelamento não encontrado.", 404);
      const fingerprint = JSON.stringify({ planId: plan.id, confirm: true });
      if (commandKey) {
        const previous = state.installmentCancelCommands.get(commandKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new FinanceAdapterError("A chave já foi usada para outro cancelamento.", 409);
          return previous.value;
        }
      }
      if (current.version !== plan.version)
        throw new FinanceAdapterError(
          "O parcelamento foi alterado por outra pessoa.",
          412,
          current.version,
        );
      const next = {
        ...current,
        version: current.version + 1,
        installments: current.installments.map((item) =>
          item.state === "planned" ? { ...item, state: "canceled" } : item,
        ),
      };
      state.installmentPlans.set(plan.id, { input: current, value: next });
      if (commandKey) state.installmentCancelCommands.set(commandKey, { fingerprint, value: next });
      return next;
    },
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
  return item.type === "payment" || item.type === "refund" ? "−" : "+";
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

export function createWorkspaceGenerationGuard(initialWorkspaceId: string) {
  let currentWorkspaceId = initialWorkspaceId;
  let generation = 0;
  return {
    switchWorkspace(workspaceId: string): void {
      if (workspaceId === currentWorkspaceId) return;
      currentWorkspaceId = workspaceId;
      generation += 1;
    },
    begin(workspaceId: string): { workspaceId: string; generation: number } {
      return { workspaceId, generation };
    },
    isCurrent(request: { workspaceId: string; generation: number }): boolean {
      return request.workspaceId === currentWorkspaceId && request.generation === generation;
    },
  };
}
