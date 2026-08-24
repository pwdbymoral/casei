import { insightWindowQuerySchema, safeToSpendQuerySchema } from "@casei/contracts";
import type { Pool, PoolClient } from "@casei/database";
import { withUnitOfWork } from "@casei/database";
import { addLocalDateDays, calculateSafeToSpend, parseLocalDate } from "@casei/domain";
import type { FinanceScope } from "./finance-service.js";
import { FinanceConflictError } from "./finance-service.js";

export interface InsightServiceOptions {
  applicationRole?: string;
  clock?: () => Date;
}

export interface InsightMoney {
  currency: string;
  minor: string;
}

export interface InsightConfidence {
  level: "high" | "medium" | "low";
  reasons: string[];
}

export interface FinancialReadModel {
  asOf: string;
  from: string;
  to: string;
  currency: string;
  balance: InsightMoney;
  result: {
    income: InsightMoney;
    expense: InsightMoney;
    transfer: InsightMoney;
    adjustment: InsightMoney;
  };
  commitments: {
    plannedIncome: InsightMoney;
    plannedOutflow: InsightMoney;
    overdueOutflow: InsightMoney;
    walletOutflow: InsightMoney;
    cardBills: InsightMoney;
    count: number;
  };
  reservations: {
    reserved: InsightMoney;
    covered: InsightMoney;
    uncovered: InsightMoney;
  };
  stock: {
    missingCount: number;
    lowCount: number;
  };
  confidence: InsightConfidence;
}

export interface SafeToSpendView {
  asOf: string;
  from: string;
  to: string;
  horizonDays: number;
  currency: string;
  available: boolean;
  safe: InsightMoney | null;
  gross: InsightMoney | null;
  confidence: InsightConfidence;
  breakdown: {
    balance: InsightMoney;
    plannedIncome: InsightMoney;
    plannedOutflow: InsightMoney;
    walletOutflow: InsightMoney;
    cardBills: InsightMoney;
    coveredReservations: InsightMoney;
    reserved: InsightMoney;
    uncoveredReservations: InsightMoney;
    safetyMargin: InsightMoney;
  };
}

export interface SafeToSpendCalculationInput {
  balance: bigint;
  plannedIncome: bigint;
  plannedOutflow: bigint;
  coveredReservations: bigint;
  safetyMargin: bigint;
}

export function calculateSafeToSpendAmounts(input: SafeToSpendCalculationInput): {
  gross: bigint;
  safe: bigint;
} {
  return calculateSafeToSpend(input);
}

interface WorkspaceConfig {
  currency: string;
  timezone: string;
  safetyMargin: bigint;
}

interface Snapshot {
  asOf: string;
  from: string;
  to: string;
  config: WorkspaceConfig;
  balance: bigint;
  hasBalanceEvidence: boolean;
  hasRecentBalanceEvidence: boolean;
  income: bigint;
  expense: bigint;
  transfer: bigint;
  adjustment: bigint;
  plannedIncome: bigint;
  walletOutflow: bigint;
  cardBills: bigint;
  overdueOutflow: bigint;
  commitmentCount: number;
  unknownVariableCount: number;
  reserved: bigint;
  missingStockCount: number;
  lowStockCount: number;
}

interface InsightNumericRow {
  balance_minor?: string | bigint | null;
  event_count?: string | bigint | null;
  evidence_count?: string | bigint | null;
  recent_evidence_count?: string | bigint | null;
  income_minor?: string | bigint | null;
  expense_minor?: string | bigint | null;
  transfer_minor?: string | bigint | null;
  adjustment_minor?: string | bigint | null;
  planned_income_minor?: string | bigint | null;
  wallet_outflow_minor?: string | bigint | null;
  overdue_outflow_minor?: string | bigint | null;
  commitment_count?: string | bigint | null;
  unknown_variable_count?: string | bigint | null;
  card_bills_minor?: string | bigint | null;
  reserved_minor?: string | bigint | null;
  missing_count?: string | bigint | null;
  low_count?: string | bigint | null;
}

/**
 * Rebuilds insight values from canonical ledger and domain tables on each
 * request. There is intentionally no persisted snapshot to invalidate.
 */
export class InsightService {
  private readonly applicationRole: string;
  private readonly clock: () => Date;

  constructor(
    private readonly pool: Pool,
    options: InsightServiceOptions = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
    this.clock = options.clock ?? (() => new Date());
  }

  async getFinancialReadModel(
    scope: FinanceScope,
    input: unknown = {},
  ): Promise<FinancialReadModel> {
    const parsed = insightWindowQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      const config = await this.workspaceConfig(client, scope.workspaceId);
      const asOf = parsed.asOf ?? this.today(config.timezone);
      const from = parsed.from ?? asOf;
      const to = parsed.to ?? asOf;
      return toFinancialReadModel(
        await this.loadSnapshot(client, scope.workspaceId, config, { asOf, from, to }),
      );
    });
  }

  async getSafeToSpend(scope: FinanceScope, input: unknown = {}): Promise<SafeToSpendView> {
    const parsed = safeToSpendQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      const config = await this.workspaceConfig(client, scope.workspaceId);
      const asOf = parsed.asOf ?? this.today(config.timezone);
      const parsedAsOf = parseLocalDate(asOf);
      if (!parsedAsOf.ok) throw new FinanceConflictError("A data de referência é inválida.");
      const to = addLocalDateDays(parsedAsOf.value, parsed.horizonDays);
      const snapshot = await this.loadSnapshot(client, scope.workspaceId, config, {
        asOf,
        from: asOf,
        to,
      });
      return toSafeToSpendView(snapshot, parsed.horizonDays);
    });
  }

  private async workspaceConfig(client: PoolClient, workspaceId: string): Promise<WorkspaceConfig> {
    const result = await client.query<{
      currency_code: string;
      timezone: string;
      safety_margin_minor: string | bigint;
    }>(
      `SELECT currency_code, timezone, safety_margin_minor
         FROM workspace_preference
        WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return {
      currency: row?.currency_code ?? "BRL",
      timezone: row?.timezone ?? "UTC",
      safetyMargin: toBigInt(row?.safety_margin_minor),
    };
  }

  private today(timezone: string): string {
    try {
      const values = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(this.clock())
          .map((part) => [part.type, part.value]),
      );
      const result = `${values.year}-${values.month}-${values.day}`;
      if (!parseLocalDate(result).ok) throw new Error("invalid civil date");
      return result;
    } catch {
      throw new FinanceConflictError("O fuso horário do espaço é inválido.");
    }
  }

  private async loadSnapshot(
    client: PoolClient,
    workspaceId: string,
    config: WorkspaceConfig,
    dates: { asOf: string; from: string; to: string },
  ): Promise<Snapshot> {
    const balanceResult = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(le.amount_minor), 0) AS balance_minor,
              COUNT(DISTINCT le.event_id) AS event_count,
              COUNT(DISTINCT ev.id) FILTER (
                WHERE ev.event_type = 'opening.balance.v1' OR ft.kind = 'adjustment'
              ) AS evidence_count,
              COUNT(DISTINCT ev.id) FILTER (
                WHERE (ev.event_type = 'opening.balance.v1' OR ft.kind = 'adjustment')
                  AND ev.occurred_on >= ($3::date - INTERVAL '30 days')
              ) AS recent_evidence_count
         FROM ledger_entry le
         JOIN ledger_event ev ON ev.workspace_id = le.workspace_id AND ev.id = le.event_id
         JOIN financial_account fa ON fa.workspace_id = le.workspace_id AND fa.id = le.account_id
         LEFT JOIN finance_transaction ft ON ft.workspace_id = ev.workspace_id AND ft.id = ev.transaction_id
        WHERE le.workspace_id = $1
          AND le.currency_code = $2
          AND fa.currency_code = $2
          AND fa.kind = 'wallet'
          AND ev.status = 'published'
          AND ev.occurred_on <= $3::date`,
      [workspaceId, config.currency, dates.asOf],
    );
    const result = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(CASE WHEN fa.kind = 'income' THEN -le.amount_minor ELSE 0 END), 0) AS income_minor,
              COALESCE(SUM(CASE WHEN fa.kind = 'expense' THEN le.amount_minor ELSE 0 END), 0) AS expense_minor,
              COALESCE(SUM(CASE WHEN fa.kind = 'adjustment' THEN -le.amount_minor ELSE 0 END), 0) AS adjustment_minor
         FROM ledger_entry le
         JOIN ledger_event ev ON ev.workspace_id = le.workspace_id AND ev.id = le.event_id
         JOIN financial_account fa ON fa.workspace_id = le.workspace_id AND fa.id = le.account_id
        WHERE le.workspace_id = $1
          AND le.currency_code = $2
          AND fa.currency_code = $2
          AND ev.status = 'published'
          AND ev.occurred_on BETWEEN $3::date AND $4::date`,
      [workspaceId, config.currency, dates.from, dates.to],
    );
    const transferResult = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS transfer_minor
         FROM finance_transaction
        WHERE workspace_id = $1
          AND currency_code = $2
          AND kind = 'transfer'
          AND state = 'posted'
          AND occurred_on BETWEEN $3::date AND $4::date`,
      [workspaceId, config.currency, dates.from, dates.to],
    );

    const commitment = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(CASE WHEN ft.kind = 'income' THEN ft.amount_minor - ft.settled_minor ELSE 0 END), 0) AS planned_income_minor,
              COALESCE(SUM(CASE WHEN ft.kind IN ('expense', 'transfer', 'adjustment') THEN ft.amount_minor - ft.settled_minor ELSE 0 END), 0) AS wallet_outflow_minor,
              COALESCE(SUM(CASE WHEN ft.kind IN ('expense', 'transfer', 'adjustment') AND ft.due_date < $4::date THEN ft.amount_minor - ft.settled_minor ELSE 0 END), 0) AS overdue_outflow_minor,
              COUNT(*) FILTER (WHERE ft.kind IN ('income', 'expense', 'transfer', 'adjustment')) AS commitment_count,
              COUNT(*) FILTER (WHERE rr.variable = true AND rr.estimated_minor IS NULL) AS unknown_variable_count
         FROM (
           SELECT ft.*, COALESCE(ft.due_on, ft.occurred_on) AS due_date
             FROM finance_transaction ft
            WHERE ft.workspace_id = $1
              AND ft.currency_code = $2
              AND ft.instrument = 'wallet'
              AND ft.state IN ('planned', 'partially_settled')
              AND COALESCE(ft.due_on, ft.occurred_on) <= $3::date
         ) ft
         LEFT JOIN recurrence_rule rr ON rr.workspace_id = ft.workspace_id AND rr.id = ft.recurrence_id`,
      [workspaceId, config.currency, dates.to, dates.asOf],
    );
    const statements = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(GREATEST(total_minor - paid_minor, 0)), 0) AS card_bills_minor
         FROM credit_statement
        WHERE workspace_id = $1
          AND state NOT IN ('paid', 'canceled')
          AND due_on <= $2::date`,
      [workspaceId, dates.to],
    );
    const reservations = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'allocate' THEN amount_minor
                               WHEN kind IN ('release', 'spend') THEN -amount_minor
                               ELSE 0 END), 0) AS reserved_minor
         FROM goal_reservation_movement
        WHERE workspace_id = $1
          AND currency_code = $2
          AND occurred_on <= $3::date`,
      [workspaceId, config.currency, dates.asOf],
    );
    const stock = await client.query<InsightNumericRow>(
      `SELECT COUNT(*) FILTER (WHERE marked_missing = true) AS missing_count,
              COUNT(*) FILTER (WHERE marked_missing = false AND quantity_milli IS NOT NULL AND minimum_milli IS NOT NULL AND quantity_milli < minimum_milli) AS low_count
         FROM stock_product
        WHERE workspace_id = $1 AND archived = false`,
      [workspaceId],
    );

    const balanceRow = balanceResult.rows[0];
    const resultRow = result.rows[0];
    const commitmentRow = commitment.rows[0];
    return {
      asOf: dates.asOf,
      from: dates.from,
      to: dates.to,
      config,
      balance: toBigInt(balanceRow?.balance_minor),
      hasBalanceEvidence: toBigInt(balanceRow?.evidence_count) > 0n,
      hasRecentBalanceEvidence: toBigInt(balanceRow?.recent_evidence_count) > 0n,
      income: toBigInt(resultRow?.income_minor),
      expense: toBigInt(resultRow?.expense_minor),
      transfer: toBigInt(transferResult.rows[0]?.transfer_minor),
      adjustment: toBigInt(resultRow?.adjustment_minor),
      plannedIncome: toBigInt(commitmentRow?.planned_income_minor),
      walletOutflow: toBigInt(commitmentRow?.wallet_outflow_minor),
      cardBills: toBigInt(statements.rows[0]?.card_bills_minor),
      overdueOutflow: toBigInt(commitmentRow?.overdue_outflow_minor),
      commitmentCount: Number(toBigInt(commitmentRow?.commitment_count)),
      unknownVariableCount: Number(toBigInt(commitmentRow?.unknown_variable_count)),
      reserved: toBigInt(reservations.rows[0]?.reserved_minor),
      missingStockCount: Number(toBigInt(stock.rows[0]?.missing_count)),
      lowStockCount: Number(toBigInt(stock.rows[0]?.low_count)),
    };
  }

  private withScopedClient<T>(
    scope: FinanceScope,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withUnitOfWork(
      this.pool,
      { ...scope, applicationRole: this.applicationRole },
      async ({ client }) => callback(client),
      { isolationLevel: "repeatable read", readOnly: true },
    );
  }
}

function toFinancialReadModel(snapshot: Snapshot): FinancialReadModel {
  const covered = coveredReservations(snapshot.balance, snapshot.reserved);
  const confidence = confidenceFor(snapshot);
  return {
    asOf: snapshot.asOf,
    from: snapshot.from,
    to: snapshot.to,
    currency: snapshot.config.currency,
    balance: money(snapshot.config.currency, snapshot.balance),
    result: {
      income: money(snapshot.config.currency, snapshot.income),
      expense: money(snapshot.config.currency, snapshot.expense),
      transfer: money(snapshot.config.currency, snapshot.transfer),
      adjustment: money(snapshot.config.currency, snapshot.adjustment),
    },
    commitments: {
      plannedIncome: money(snapshot.config.currency, snapshot.plannedIncome),
      plannedOutflow: money(snapshot.config.currency, snapshot.walletOutflow + snapshot.cardBills),
      overdueOutflow: money(snapshot.config.currency, snapshot.overdueOutflow),
      walletOutflow: money(snapshot.config.currency, snapshot.walletOutflow),
      cardBills: money(snapshot.config.currency, snapshot.cardBills),
      count: snapshot.commitmentCount,
    },
    reservations: {
      reserved: money(snapshot.config.currency, snapshot.reserved),
      covered: money(snapshot.config.currency, covered),
      uncovered: money(snapshot.config.currency, snapshot.reserved - covered),
    },
    stock: { missingCount: snapshot.missingStockCount, lowCount: snapshot.lowStockCount },
    confidence,
  };
}

function toSafeToSpendView(snapshot: Snapshot, horizonDays: number): SafeToSpendView {
  const covered = coveredReservations(snapshot.balance, snapshot.reserved);
  const plannedOutflow = snapshot.walletOutflow + snapshot.cardBills;
  const calculation = calculateSafeToSpendAmounts({
    balance: snapshot.balance,
    plannedIncome: snapshot.plannedIncome,
    plannedOutflow,
    coveredReservations: covered,
    safetyMargin: snapshot.config.safetyMargin,
  });
  const available = snapshot.hasBalanceEvidence;
  const currency = snapshot.config.currency;
  return {
    asOf: snapshot.asOf,
    from: snapshot.from,
    to: snapshot.to,
    horizonDays,
    currency,
    available,
    safe: available ? money(currency, calculation.safe) : null,
    gross: available ? money(currency, calculation.gross) : null,
    confidence: confidenceFor(snapshot),
    breakdown: {
      balance: money(currency, snapshot.balance),
      plannedIncome: money(currency, snapshot.plannedIncome),
      plannedOutflow: money(currency, plannedOutflow),
      walletOutflow: money(currency, snapshot.walletOutflow),
      cardBills: money(currency, snapshot.cardBills),
      coveredReservations: money(currency, covered),
      reserved: money(currency, snapshot.reserved),
      uncoveredReservations: money(currency, snapshot.reserved - covered),
      safetyMargin: money(currency, snapshot.config.safetyMargin),
    },
  };
}

function confidenceFor(snapshot: Snapshot): InsightConfidence {
  if (!snapshot.hasBalanceEvidence) {
    return { level: "low", reasons: ["saldo_sem_evidencia_de_abertura_ou_conferencia"] };
  }
  const reasons: string[] = [];
  if (!snapshot.hasRecentBalanceEvidence) reasons.push("saldo_sem_conferencia_recente");
  if (snapshot.unknownVariableCount > 0) reasons.push("recorrencia_variavel_sem_estimativa");
  if (reasons.length > 0) return { level: "medium", reasons };
  return { level: "high", reasons: ["saldo_conferido_recentemente"] };
}

function coveredReservations(balance: bigint, reserved: bigint): bigint {
  if (reserved < 0n) throw new FinanceConflictError("As reservas do espaço estão inconsistentes.");
  const availableBalance = balance > 0n ? balance : 0n;
  return reserved < availableBalance ? reserved : availableBalance;
}

function money(currency: string, minor: bigint): InsightMoney {
  return { currency, minor: minor.toString() };
}

function toBigInt(value: string | bigint | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(value);
}
