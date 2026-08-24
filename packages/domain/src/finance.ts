import { DomainError } from "./errors.js";
import { Money } from "./money.js";
import { addLocalDateDays, addLocalDateMonths, type LocalDate, parseLocalDate } from "./time.js";

export interface LedgerPosting {
  readonly accountId: string;
  readonly amount: Money;
}

export interface CanonicalPostingAccounts {
  readonly wallet: string;
  readonly income: string;
  readonly expense: string;
  readonly adjustment: string;
  readonly cardLiability?: string;
}

/** Canonical double-entry effects used by wallet, card purchases and payments. */
export function canonicalTransactionPostings(input: {
  kind: "income" | "expense" | "transfer" | "adjustment";
  instrument: "wallet" | "card";
  amount: Money;
  accounts: CanonicalPostingAccounts;
}): readonly LedgerPosting[] {
  if (input.amount.minor <= 0n) {
    throw new DomainError("validation_failed", "O valor do lançamento deve ser positivo.");
  }
  if (input.instrument === "card") {
    if (input.kind !== "expense" || !input.accounts.cardLiability) {
      throw new DomainError(
        "validation_failed",
        "Somente despesas podem usar o passivo do cartão.",
      );
    }
    return [
      { accountId: input.accounts.expense, amount: input.amount },
      {
        accountId: input.accounts.cardLiability,
        amount: Money.fromTrusted(-input.amount.minor, input.amount.currency),
      },
    ];
  }
  if (input.kind === "income") {
    return [
      { accountId: input.accounts.wallet, amount: input.amount },
      {
        accountId: input.accounts.income,
        amount: Money.fromTrusted(-input.amount.minor, input.amount.currency),
      },
    ];
  }
  if (input.kind === "expense") {
    return [
      { accountId: input.accounts.expense, amount: input.amount },
      {
        accountId: input.accounts.wallet,
        amount: Money.fromTrusted(-input.amount.minor, input.amount.currency),
      },
    ];
  }
  if (input.kind === "adjustment") {
    return [
      { accountId: input.accounts.wallet, amount: input.amount },
      {
        accountId: input.accounts.adjustment,
        amount: Money.fromTrusted(-input.amount.minor, input.amount.currency),
      },
    ];
  }
  throw new DomainError("validation_failed", "Uma transferência exige contas de origem e destino.");
}

export function canonicalCardPaymentPostings(input: {
  amount: Money;
  wallet: string;
  cardLiability: string;
}): readonly LedgerPosting[] {
  if (input.amount.minor <= 0n) {
    throw new DomainError("validation_failed", "O pagamento deve ser positivo.");
  }
  return [
    {
      accountId: input.wallet,
      amount: Money.fromTrusted(-input.amount.minor, input.amount.currency),
    },
    { accountId: input.cardLiability, amount: input.amount },
  ];
}

/**
 * A published event is valid only when its postings form one balanced,
 * non-zero, single-currency unit. The database repeats this invariant with a
 * deferred constraint trigger; keeping it here gives callers a safe failure
 * before opening a transaction.
 */
export function assertBalancedLedgerEvent(postings: readonly LedgerPosting[]): void {
  if (postings.length < 2) {
    throw new DomainError("validation_failed", "Um evento precisa de ao menos dois lançamentos.");
  }
  const currencies = new Set(postings.map((posting) => posting.amount.currency));
  if (currencies.size !== 1) {
    throw new DomainError("currency_mismatch", "Todos os lançamentos devem usar a mesma moeda.");
  }
  if (postings.some((posting) => posting.amount.minor === 0n || posting.accountId.length === 0)) {
    throw new DomainError(
      "validation_failed",
      "Lançamentos não podem ter valor zero ou conta vazia.",
    );
  }
  const total = postings.reduce((sum, posting) => sum + posting.amount.minor, 0n);
  if (total !== 0n) {
    throw new DomainError("validation_failed", "A soma dos lançamentos deve ser zero.");
  }
}

export function distributeInstallments(total: Money, count: number): readonly Money[] {
  if (!Number.isInteger(count) || count < 2 || count > 999 || total.minor <= 0n) {
    throw new DomainError(
      "validation_failed",
      "O parcelamento deve ter de 2 a 999 parcelas positivas.",
    );
  }
  const base = total.minor / BigInt(count);
  let remainder = total.minor % BigInt(count);
  return Array.from({ length: count }, () => {
    const part = base + (remainder > 0n ? 1n : 0n);
    remainder -= remainder > 0n ? 1n : 0n;
    return Money.fromTrusted(part, total.currency);
  });
}

export type RecurrenceFrequency = "weekly" | "monthly" | "annual";

export function generateRecurrenceDates(
  frequency: RecurrenceFrequency,
  start: string,
  count: number,
  interval = 1,
): readonly string[] {
  const parsed = parseLocalDate(start);
  if (!parsed.ok || !Number.isInteger(count) || count < 1 || count > 10_000) {
    throw new DomainError(
      "validation_failed",
      "A recorrência precisa de data e quantidade válidas.",
    );
  }
  if (!Number.isInteger(interval) || interval < 1) {
    throw new DomainError("validation_failed", "O intervalo da recorrência deve ser positivo.");
  }
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const current =
      index === 0 ? parsed.value : addRecurrence(parsed.value, frequency, interval * index);
    result.push(current);
  }
  return result;
}

/** Generates an anchored recurrence through an inclusive civil-date horizon. */
export function generateRecurrenceDatesUntil(
  frequency: RecurrenceFrequency,
  start: string,
  until: string,
  interval = 1,
  maxOccurrences = 10_000,
): readonly string[] {
  const parsedStart = parseLocalDate(start);
  const parsedUntil = parseLocalDate(until);
  if (!parsedStart.ok || !parsedUntil.ok) {
    throw new DomainError("validation_failed", "A recorrência precisa de datas civis válidas.");
  }
  if (!Number.isInteger(interval) || interval < 1) {
    throw new DomainError("validation_failed", "O intervalo da recorrência deve ser positivo.");
  }
  if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 10_000) {
    throw new DomainError("validation_failed", "O limite da recorrência é inválido.");
  }
  const result: string[] = [];
  for (let index = 0; index < maxOccurrences; index += 1) {
    const current =
      index === 0
        ? parsedStart.value
        : addRecurrence(parsedStart.value, frequency, interval * index);
    if (current > parsedUntil.value) break;
    result.push(current);
  }
  return result;
}

function addRecurrence(
  date: LocalDate,
  frequency: RecurrenceFrequency,
  interval: number,
): LocalDate {
  if (frequency === "weekly") return addLocalDateDays(date, 7 * interval);
  return addLocalDateMonths(date, (frequency === "annual" ? 12 : 1) * interval);
}

export interface StatementDates {
  readonly periodStart: string;
  readonly closingOn: string;
  readonly dueOn: string;
}

/** Returns the persisted cycle dates for a date in the target cycle. */
export function calculateStatementDates(
  date: string,
  closingDay: number,
  dueDay: number,
  mode: "cycle" | "purchase" = "cycle",
): StatementDates {
  const parsed = parseLocalDate(date);
  if (!parsed.ok || !Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
    throw new DomainError("validation_failed", "Data ou dia de fechamento inválido.");
  }
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new DomainError("validation_failed", "Dia de vencimento inválido.");
  }
  const [yearText, monthText, dayText] = date.split("-");
  let year = Number(yearText);
  let month = Number(monthText);
  if (mode === "purchase" && Number(dayText) >= Math.min(closingDay, daysInMonth(year, month))) {
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  const closing = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${Math.min(
    closingDay,
    daysInMonth(year, month),
  )
    .toString()
    .padStart(2, "0")}`;
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const previousClosingDay = Math.min(
    closingDay,
    daysInMonth(previous.getUTCFullYear(), previous.getUTCMonth() + 1),
  );
  previous.setUTCDate(previousClosingDay + 1);
  const periodStart = `${previous.getUTCFullYear().toString().padStart(4, "0")}-${(
    previous.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${previous.getUTCDate().toString().padStart(2, "0")}`;
  let dueYear = year;
  let dueMonth = month;
  if (dueDay < closingDay) {
    dueMonth += 1;
    if (dueMonth === 13) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  const dueOn = `${dueYear.toString().padStart(4, "0")}-${dueMonth.toString().padStart(2, "0")}-${Math.min(
    dueDay,
    daysInMonth(dueYear, dueMonth),
  )
    .toString()
    .padStart(2, "0")}`;
  return { periodStart, closingOn: closing, dueOn };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function requiredGoalContribution(
  target: bigint,
  reserved: bigint,
  periodsRemaining: number,
): bigint | null {
  if (periodsRemaining <= 0 || !Number.isInteger(periodsRemaining)) return null;
  const remaining = target - reserved;
  if (remaining <= 0n) return 0n;
  const periods = BigInt(periodsRemaining);
  return (remaining + periods - 1n) / periods;
}

export interface SafeToSpendInput {
  readonly balance: bigint;
  readonly plannedIncome: bigint;
  readonly plannedOutflow: bigint;
  readonly coveredReservations: bigint;
  readonly safetyMargin: bigint;
}

export function calculateSafeToSpend(input: SafeToSpendInput): { safe: bigint; gross: bigint } {
  const gross =
    input.balance +
    input.plannedIncome -
    input.plannedOutflow -
    input.coveredReservations -
    input.safetyMargin;
  return { safe: gross > 0n ? gross : 0n, gross };
}
