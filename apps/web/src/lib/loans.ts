import { configuredApiOrigin } from "./api-origin";

export type LoanMoney = { currency: string; minor: string };

export type Loan = {
  id: string;
  workspaceId: string;
  direction: "lent" | "borrowed";
  counterparty: string;
  principal: LoanMoney;
  paid: LoanMoney;
  remaining: LoanMoney;
  occurredOn: string;
  dueOn: string | null;
  status: "open" | "settled";
  version: number;
};

export type LoanPayment = {
  id: string;
  loanId: string;
  amount: LoanMoney;
  occurredOn: string;
};

export type LoanPaymentResponse = { loan: Loan; payment: LoanPayment };

export type CreateLoanInput = {
  direction: Loan["direction"];
  counterparty: string;
  principal: LoanMoney;
  occurredOn?: string;
  dueOn?: string | null;
};

export type LoanPaymentInput = { amount: LoanMoney; occurredOn?: string };
export type LoanPage = { items: Loan[]; nextCursor: string | null; hasMore: boolean };
export type LoanPageQuery = { limit?: number };
export type LoanPaymentPage = {
  items: LoanPayment[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type LoanPaymentPageQuery = { cursor?: string; limit?: number };

export type LoansAdapter = {
  listLoans(workspaceId: string, query?: LoanPageQuery): Promise<LoanPage>;
  listPayments(
    workspaceId: string,
    loanId: string,
    query?: LoanPaymentPageQuery,
  ): Promise<LoanPaymentPage>;
  createLoan(workspaceId: string, input: CreateLoanInput, idempotencyKey?: string): Promise<Loan>;
  payLoan(
    workspaceId: string,
    loan: Loan,
    input: LoanPaymentInput,
    idempotencyKey?: string,
  ): Promise<LoanPaymentResponse>;
};

export class LoansAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "LoansAdapterError";
  }
}

export function loanProgressPercent(loan: Pick<Loan, "principal" | "paid">): number {
  const principal = BigInt(loan.principal.minor);
  if (principal <= BigInt(0)) return 0;
  const paid = BigInt(loan.paid.minor);
  const bounded = paid <= BigInt(0) ? BigInt(0) : paid > principal ? principal : paid;
  return Number((bounded * BigInt(100)) / principal);
}

export function loanDirectionLabel(direction: Loan["direction"]): string {
  return direction === "lent" ? "Você emprestou" : "Você pegou emprestado";
}

export function loanCounterpartyAction(direction: Loan["direction"]): string {
  return direction === "lent" ? "A receber" : "A pagar";
}

export function loanStatusLabel(status: Loan["status"]): string {
  return status === "settled" ? "Quitado" : "Em aberto";
}

const unavailableLoanOperation = async (..._args: unknown[]): Promise<never> => {
  throw new LoansAdapterError(
    "Seus empréstimos não estão disponíveis. Entre novamente para continuar.",
    401,
  );
};

export const unauthenticatedLoansAdapter: LoansAdapter = {
  listLoans: unavailableLoanOperation,
  listPayments: unavailableLoanOperation,
  createLoan: unavailableLoanOperation,
  payLoan: unavailableLoanOperation,
};

type JsonPage<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };

export function createHttpLoansAdapter(
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): LoansAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

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
      throw new LoansAdapterError("Não foi possível conectar ao Casei.");
    }
    const payload = (await response.json().catch(() => null)) as
      | T
      | { error?: { message?: string; currentVersion?: number } }
      | null;
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      throw new LoansAdapterError(
        error?.message ?? "Não foi possível atualizar o empréstimo.",
        response.status,
        error?.currentVersion,
      );
    }
    return payload as T;
  }

  const idempotencyKey = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;
  const path = (workspaceId: string, suffix = "") =>
    `/workspaces/${encodeURIComponent(workspaceId)}/loans${suffix}`;

  return {
    listLoans: async (workspaceId, query = {}) => {
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const search = params.toString();
      const page = await call<JsonPage<Loan>>(path(workspaceId) + (search ? `?${search}` : ""));
      return {
        items: page.items,
        nextCursor: page.page.nextCursor,
        hasMore: page.page.hasMore,
      };
    },
    listPayments: async (workspaceId, loanId, query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const search = params.toString();
      const page = await call<JsonPage<LoanPayment>>(
        path(workspaceId, `/${encodeURIComponent(loanId)}/payments`) + (search ? `?${search}` : ""),
      );
      return {
        items: page.items,
        nextCursor: page.page.nextCursor,
        hasMore: page.page.hasMore,
      };
    },
    createLoan: (workspaceId, input, commandKey) =>
      call<Loan>(path(workspaceId), {
        method: "POST",
        headers: { "Idempotency-Key": commandKey ?? idempotencyKey("loan-create") },
        body: JSON.stringify(input),
      }),
    payLoan: (workspaceId, loan, input, commandKey) =>
      call<LoanPaymentResponse>(path(workspaceId, `/${encodeURIComponent(loan.id)}/payments`), {
        method: "POST",
        headers: {
          "Idempotency-Key": commandKey ?? idempotencyKey("loan-payment"),
          "If-Match": `"v${loan.version}"`,
        },
        body: JSON.stringify(input),
      }),
  };
}

type FixtureLoansAdapter = LoansAdapter;

type FixtureCommand = {
  fingerprint: string;
  result: Loan | LoanPaymentResponse;
};

function createLoanFingerprint(input: CreateLoanInput): string {
  return JSON.stringify({
    direction: input.direction,
    counterparty: input.counterparty.trim(),
    principal: {
      currency: input.principal.currency,
      minor: input.principal.minor,
    },
    occurredOn: input.occurredOn ?? null,
    dueOn: input.dueOn ?? null,
  });
}

function paymentFingerprint(loan: Loan, input: LoanPaymentInput): string {
  return JSON.stringify({
    loanId: loan.id,
    expectedVersion: loan.version,
    amount: {
      currency: input.amount.currency,
      minor: input.amount.minor,
    },
    occurredOn: input.occurredOn ?? null,
  });
}

function idempotencyConflict(): LoansAdapterError {
  return new LoansAdapterError("A chave de idempotência já foi usada com dados diferentes.", 409);
}

function compareLoanPayments(left: LoanPayment, right: LoanPayment): number {
  return right.occurredOn.localeCompare(left.occurredOn) || right.id.localeCompare(left.id);
}

export function upsertLoanPayment(history: LoanPayment[], payment: LoanPayment): LoanPayment[] {
  return [...history.filter((item) => item.id !== payment.id), payment].sort(compareLoanPayments);
}

export async function listAllLoanPayments(
  adapter: Pick<LoansAdapter, "listPayments">,
  workspaceId: string,
  loanId: string,
  limit = 100,
): Promise<LoanPayment[]> {
  const items: LoanPayment[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  const visited = new Set<string>();
  while (hasMore) {
    const page = await adapter.listPayments(workspaceId, loanId, {
      ...(cursor ? { cursor } : {}),
      limit,
    });
    items.push(...page.items);
    hasMore = page.hasMore;
    if (!hasMore) break;
    if (!page.nextCursor) {
      throw new LoansAdapterError("O histórico retornou uma paginação incompleta.");
    }
    if (visited.has(page.nextCursor)) {
      throw new LoansAdapterError("O histórico retornou uma paginação inválida.");
    }
    visited.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return items;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function copyMoney(money: LoanMoney): LoanMoney {
  return { ...money };
}

function copyLoan(loan: Loan): Loan {
  return {
    ...loan,
    principal: copyMoney(loan.principal),
    paid: copyMoney(loan.paid),
    remaining: copyMoney(loan.remaining),
  };
}

function copyPayment(payment: LoanPayment): LoanPayment {
  return { ...payment, amount: copyMoney(payment.amount) };
}

function fixtureLoan(workspaceId: string, id: string, values: Partial<Loan> = {}): Loan {
  const principal = values.principal ?? { currency: "BRL", minor: "120000" };
  const paid = values.paid ?? { currency: principal.currency, minor: "0" };
  return {
    id,
    workspaceId,
    direction: values.direction ?? "lent",
    counterparty: values.counterparty ?? "João",
    principal,
    paid,
    remaining: values.remaining ?? { currency: principal.currency, minor: principal.minor },
    occurredOn: values.occurredOn ?? "2026-08-01",
    dueOn: values.dueOn === undefined ? "2026-09-01" : values.dueOn,
    status: values.status ?? "open",
    version: values.version ?? 0,
  };
}

export function createFixtureLoansAdapter(): FixtureLoansAdapter {
  const loans = new Map<string, Loan[]>();
  const payments = new Map<string, LoanPayment[]>();
  const commands = new Map<string, FixtureCommand>();
  let sequence = 0;

  const list = (workspaceId: string): Loan[] => {
    const existing = loans.get(workspaceId);
    if (existing) return existing;
    const seeded =
      workspaceId === "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201"
        ? [
            fixtureLoan(workspaceId, "fixture-loan-marina-1", {
              counterparty: "Rafa",
              principal: { currency: "BRL", minor: "80000" },
              paid: { currency: "BRL", minor: "20000" },
              remaining: { currency: "BRL", minor: "60000" },
              direction: "lent",
            }),
            fixtureLoan(workspaceId, "fixture-loan-marina-2", {
              counterparty: "Mãe",
              principal: { currency: "BRL", minor: "45000" },
              direction: "borrowed",
              dueOn: "2026-08-30",
            }),
          ]
        : [];
    loans.set(workspaceId, seeded);
    if (workspaceId === "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201") {
      payments.set(`${workspaceId}:fixture-loan-marina-1`, [
        {
          id: "fixture-payment-marina-1",
          loanId: "fixture-loan-marina-1",
          amount: { currency: "BRL", minor: "20000" },
          occurredOn: "2026-08-15",
        },
      ]);
    }
    return seeded;
  };

  const assertLoan = (workspaceId: string, loanId: string): Loan => {
    const found = list(workspaceId).find((item) => item.id === loanId);
    if (!found) throw new LoansAdapterError("Empréstimo não encontrado.", 404);
    return found;
  };

  const adapter: FixtureLoansAdapter = {
    async listLoans(workspaceId, query = {}) {
      const bounded = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const items = [...list(workspaceId)].sort((left, right) => {
        if (left.status !== right.status) return left.status === "open" ? -1 : 1;
        if (left.dueOn === null) return 1;
        if (right.dueOn === null) return -1;
        return left.dueOn.localeCompare(right.dueOn);
      });
      return { items: items.slice(0, bounded).map(copyLoan), nextCursor: null, hasMore: false };
    },
    async createLoan(workspaceId, input, commandKey) {
      if (commandKey) {
        const commandId = `create:${workspaceId}:${commandKey}`;
        const replay = commands.get(commandId);
        if (replay) {
          if (replay.fingerprint !== createLoanFingerprint(input)) {
            throw idempotencyConflict();
          }
          if ("direction" in replay.result) return copyLoan(replay.result);
          throw idempotencyConflict();
        }
      }
      const principalMinor = BigInt(input.principal.minor);
      if (principalMinor <= BigInt(0)) {
        throw new LoansAdapterError("Informe um principal maior que zero.", 422);
      }
      const occurredOn = input.occurredOn ?? today();
      if (input.dueOn && input.dueOn < occurredOn) {
        throw new LoansAdapterError(
          "O vencimento não pode ser anterior à data do empréstimo.",
          422,
        );
      }
      const created = fixtureLoan(workspaceId, `fixture-loan-${++sequence}`, {
        direction: input.direction,
        counterparty: input.counterparty.trim(),
        principal: copyMoney(input.principal),
        paid: { ...input.principal, minor: "0" },
        remaining: copyMoney(input.principal),
        occurredOn,
        dueOn: input.dueOn ?? null,
      });
      list(workspaceId).push(created);
      if (commandKey) {
        commands.set(`create:${workspaceId}:${commandKey}`, {
          fingerprint: createLoanFingerprint(input),
          result: created,
        });
      }
      return copyLoan(created);
    },
    async payLoan(workspaceId, loan, input, commandKey) {
      const commandId = commandKey ? `payment:${workspaceId}:${loan.id}:${commandKey}` : null;
      if (commandId) {
        const replay = commands.get(commandId);
        if (replay) {
          if (replay.fingerprint !== paymentFingerprint(loan, input)) {
            throw idempotencyConflict();
          }
          if ("payment" in replay.result) {
            return {
              loan: copyLoan(replay.result.loan),
              payment: copyPayment(replay.result.payment),
            };
          }
          throw idempotencyConflict();
        }
      }
      const current = assertLoan(workspaceId, loan.id);
      if (current.version !== loan.version) {
        throw new LoansAdapterError(
          "O empréstimo foi alterado. Atualize antes de pagar.",
          412,
          current.version,
        );
      }
      if (current.status !== "open")
        throw new LoansAdapterError("O empréstimo já está quitado.", 409);
      if (input.amount.currency !== current.principal.currency) {
        throw new LoansAdapterError("A moeda do pagamento difere do empréstimo.", 409);
      }
      const amount = BigInt(input.amount.minor);
      const remaining = BigInt(current.remaining.minor);
      if (amount <= BigInt(0) || amount > remaining) {
        throw new LoansAdapterError(
          "O pagamento deve ser positivo e não pode exceder o saldo.",
          409,
        );
      }
      const occurredOn = input.occurredOn ?? today();
      if (occurredOn < current.occurredOn) {
        throw new LoansAdapterError(
          "A data do pagamento não pode ser anterior à data do empréstimo.",
          409,
        );
      }
      const nextPaid = BigInt(current.paid.minor) + amount;
      const nextRemaining = BigInt(current.principal.minor) - nextPaid;
      const next: Loan = {
        ...current,
        paid: { ...current.paid, minor: nextPaid.toString() },
        remaining: { ...current.remaining, minor: nextRemaining.toString() },
        status: nextRemaining === BigInt(0) ? "settled" : "open",
        version: current.version + 1,
      };
      const payment: LoanPayment = {
        id: `fixture-payment-${++sequence}`,
        loanId: current.id,
        amount: copyMoney(input.amount),
        occurredOn,
      };
      const index = list(workspaceId).findIndex((item) => item.id === current.id);
      list(workspaceId)[index] = next;
      const historyKey = `${workspaceId}:${current.id}`;
      payments.set(historyKey, upsertLoanPayment(payments.get(historyKey) ?? [], payment));
      const response = { loan: next, payment };
      if (commandId) {
        commands.set(commandId, { fingerprint: paymentFingerprint(loan, input), result: response });
      }
      return { loan: copyLoan(next), payment: copyPayment(payment) };
    },
    async listPayments(workspaceId, loanId, query = {}) {
      assertLoan(workspaceId, loanId);
      const ordered = [...(payments.get(`${workspaceId}:${loanId}`) ?? [])].sort(
        compareLoanPayments,
      );
      const start = query.cursor
        ? ordered.findIndex((payment) => payment.id === query.cursor) + 1
        : 0;
      if (query.cursor && start === 0) {
        throw new LoansAdapterError("Cursor de pagamentos inválido.", 400);
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const items = ordered.slice(start, start + limit);
      const hasMore = start + items.length < ordered.length;
      return {
        items: items.map(copyPayment),
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
        hasMore,
      };
    },
  };
  return adapter;
}

export function loansAdapterForEnvironment(options: { fixtures?: boolean } = {}): LoansAdapter {
  if (
    process.env.NODE_ENV !== "production" &&
    (options.fixtures === true || process.env.CASEI_UI_FIXTURES === "1")
  )
    return createFixtureLoansAdapter();
  const origin = configuredApiOrigin();
  return origin ? createHttpLoansAdapter({ baseUrl: origin }) : unauthenticatedLoansAdapter;
}
