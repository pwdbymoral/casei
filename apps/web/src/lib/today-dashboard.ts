import {
  commitmentBucket,
  commitmentRemainingMinor,
  type Statement,
  type Transaction,
} from "./finance";
import type { Goal } from "./goals";
import type { FinancialReadModel, SafeToSpendView } from "./insights";
import type { StockShoppingItem } from "./stock";

export type TodayCommitment = {
  id: string;
  title: string;
  dueOn: string;
  amountMinor: string;
  currency: string;
  bucket: "overdue" | "upcoming";
  href: string;
};

export type TodayDashboardData = {
  financial: FinancialReadModel;
  safeToSpend: SafeToSpendView;
  commitments: TodayCommitment[];
  goals: Goal[];
  shoppingItems: StockShoppingItem[];
};

export type SafeToSpendCardState = {
  kind: "unavailable" | "available" | "deficit";
  ctaLabel: "Revisar dados necessários" | "Entender o cálculo" | "Revisar déficit";
};

/** Maps the read model's safe/gross pair to the actionable state shown on Hoje. */
export function safeToSpendCardState(input: {
  available: boolean;
  gross: { minor: string } | null;
}): SafeToSpendCardState {
  if (!input.available) return { kind: "unavailable", ctaLabel: "Revisar dados necessários" };
  if (input.gross !== null && BigInt(input.gross.minor) < BigInt(0)) {
    return { kind: "deficit", ctaLabel: "Revisar déficit" };
  }
  return { kind: "available", ctaLabel: "Entender o cálculo" };
}

type CommitmentTransaction = Pick<
  Transaction,
  "id" | "kind" | "state" | "amount" | "settledAmount" | "dueOn" | "description"
>;
type CommitmentStatement = Pick<Statement, "id" | "state" | "dueOn" | "openAmount">;
type AttentionGoal = Pick<
  Goal,
  "id" | "name" | "reserved" | "uncovered" | "deadline" | "priority" | "status"
>;

function dateToDayNumber(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

export function addCivilDays(value: string, days: number): string {
  const day = dateToDayNumber(value);
  if (!Number.isFinite(day)) return value;
  const date = new Date((day + days) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function transactionTitle(transaction: Pick<Transaction, "kind" | "description">): string {
  if (transaction.description.trim()) return transaction.description;
  return transaction.kind === "income" ? "Receita prevista" : "Pagamento previsto";
}

function statementTitle(statement: Pick<Statement, "state">): string {
  return statement.state === "partially_paid" ? "Fatura parcialmente paga" : "Fatura do cartão";
}

/** Converts canonical financial facts into the small, actionable list shown on Hoje. */
export function buildTodayCommitments(input: {
  transactions: CommitmentTransaction[];
  statements: CommitmentStatement[];
  asOf: string;
  currency: string;
  days?: number;
}): TodayCommitment[] {
  const end = addCivilDays(input.asOf, input.days ?? 7);
  const transactions = input.transactions.flatMap((transaction) => {
    const bucket = commitmentBucket(transaction, input.asOf);
    const amountMinor = commitmentRemainingMinor(transaction);
    if (!bucket || !transaction.dueOn || transaction.dueOn > end || amountMinor === "0") return [];
    return [
      {
        id: transaction.id,
        title: transactionTitle(transaction),
        dueOn: transaction.dueOn,
        amountMinor,
        currency: transaction.amount.currency,
        bucket,
        href: `/app/finances?transaction=${encodeURIComponent(transaction.id)}`,
      },
    ];
  });
  const statements = input.statements.flatMap((statement) => {
    if (
      (statement.state !== "open" &&
        statement.state !== "closed" &&
        statement.state !== "partially_paid") ||
      statement.openAmount.minor === "0" ||
      statement.dueOn > end
    )
      return [];
    const bucket = statement.dueOn < input.asOf ? "overdue" : "upcoming";
    return [
      {
        id: `statement-${statement.id}`,
        title: statementTitle(statement),
        dueOn: statement.dueOn,
        amountMinor: statement.openAmount.minor,
        currency: statement.openAmount.currency || input.currency,
        bucket: bucket as "overdue" | "upcoming",
        href: `/app/finances?statement=${encodeURIComponent(statement.id)}`,
      },
    ];
  });
  return [...transactions, ...statements].sort((left, right) => {
    const bucketOrder = left.bucket === right.bucket ? 0 : left.bucket === "overdue" ? -1 : 1;
    return (
      bucketOrder || left.dueOn.localeCompare(right.dueOn) || left.title.localeCompare(right.title)
    );
  });
}

export function goalsRequiringAttention(goals: AttentionGoal[], asOf: string): AttentionGoal[] {
  const limit = addCivilDays(asOf, 30);
  return goals
    .filter((goal) => {
      if (goal.status !== "active") return false;
      if (BigInt(goal.uncovered.minor) > BigInt(0)) return true;
      return goal.deadline !== null && goal.deadline <= limit;
    })
    .sort((left, right) => {
      const leftUrgency =
        (BigInt(left.uncovered.minor) > BigInt(0) ? 1 : 0) + (left.priority === "high" ? 1 : 0);
      const rightUrgency =
        (BigInt(right.uncovered.minor) > BigInt(0) ? 1 : 0) + (right.priority === "high" ? 1 : 0);
      return (
        rightUrgency - leftUrgency ||
        (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999")
      );
    });
}
