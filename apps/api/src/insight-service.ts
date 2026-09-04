import {
  insightReportQuerySchema,
  insightWindowQuerySchema,
  projectionQuerySchema,
  safeToSpendQuerySchema,
} from "@casei/contracts";
import type { Pool, PoolClient } from "@casei/database";
import { withUnitOfWork } from "@casei/database";
import {
  addLocalDateDays,
  addLocalDateMonths,
  calculateSafeToSpend,
  parseLocalDate,
} from "@casei/domain";
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
    loanReceivable: InsightMoney;
    loanPayable: InsightMoney;
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
    loanReceivable: InsightMoney;
    loanPayable: InsightMoney;
    coveredReservations: InsightMoney;
    reserved: InsightMoney;
    uncoveredReservations: InsightMoney;
    safetyMargin: InsightMoney;
  };
}

export interface InsightReportPeriod {
  month: string;
  income: InsightMoney;
  expense: InsightMoney;
  net: InsightMoney;
  transactionCount: number;
}

export interface InsightReportCategory {
  categoryId: string | null;
  categoryName: string;
  income: InsightMoney;
  expense: InsightMoney;
  net: InsightMoney;
  transactionCount: number;
}

export interface InsightReportView {
  asOf: string;
  from: string;
  to: string;
  currency: string;
  filters: { kind: "all" | "income" | "expense"; categoryId: string | null };
  totals: {
    income: InsightMoney;
    expense: InsightMoney;
    net: InsightMoney;
    transactionCount: number;
  };
  monthly: InsightReportPeriod[];
  categories: InsightReportCategory[];
  reconciliation: {
    source: "published_ledger";
    transactionCount: number;
    income: InsightMoney;
    expense: InsightMoney;
    export: {
      domain: "transactions";
      format: "csv";
      from: string;
      to: string;
      kind: "all" | "income" | "expense";
      categoryId: string | null;
    };
  };
}

export type FinancialProjection = CashFlowProjection;

export interface SafeToSpendCalculationInput {
  balance: bigint;
  plannedIncome: bigint;
  plannedOutflow: bigint;
  coveredReservations: bigint;
  safetyMargin: bigint;
}

export type CashFlowProjectionEvent = {
  id: string;
  date: string;
  direction: "income" | "outflow";
  amount: bigint | null;
  source: {
    type: "transaction" | "recurrence" | "installment" | "statement" | "loan" | "goal";
    id: string;
    label: string;
  };
};

export type CashFlowProjectionPoint = {
  date: string;
  balance: InsightMoney;
  delta: InsightMoney;
  events: Array<{
    id: string;
    date: string;
    direction: "income" | "outflow";
    amount: InsightMoney | null;
    source: CashFlowProjectionEvent["source"];
  }>;
  unknownEventCount: number;
};

export type CashFlowProjection = {
  asOf: string;
  to: string;
  months: number;
  currency: string;
  startingBalance: InsightMoney;
  points: CashFlowProjectionPoint[];
  confidence: InsightConfidence;
};

/**
 * Projects known cash events without mutating the caller's event list. Each
 * point is a deterministic one-month boundary and carries the events that
 * explain its delta. Unknown variable events remain visible but do not get
 * silently treated as zero-valued income or outflow.
 */
export function projectCashFlow(input: {
  asOf: string;
  months: number;
  currency: string;
  startingBalance: bigint;
  events: readonly CashFlowProjectionEvent[];
}): CashFlowProjection {
  const parsedAsOf = parseLocalDate(input.asOf);
  if (!parsedAsOf.ok) throw new FinanceConflictError("A data de referência é inválida.");
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 12) {
    throw new FinanceConflictError("O horizonte da projeção deve estar entre 1 e 12 meses.");
  }
  const sorted = [...input.events]
    .filter((event) => parseLocalDate(event.date).ok)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  let balance = input.startingBalance;
  let cursor = 0;
  let previous = input.asOf;
  const points: CashFlowProjectionPoint[] = [];
  let unknownEventCount = 0;
  for (let month = 1; month <= input.months; month += 1) {
    const date = addLocalDateMonths(parsedAsOf.value, month);
    const events: CashFlowProjectionPoint["events"] = [];
    let delta = 0n;
    while (cursor < sorted.length) {
      const event = sorted[cursor];
      if (!event) break;
      const belongsToPoint = event.date <= date && (month === 1 || event.date > previous);
      if (!belongsToPoint) {
        if (event.date > date) break;
        cursor += 1;
        continue;
      }
      cursor += 1;
      const signedAmount =
        event.amount === null ? null : event.direction === "income" ? event.amount : -event.amount;
      if (signedAmount === null) unknownEventCount += 1;
      else {
        delta += signedAmount;
        balance += signedAmount;
      }
      events.push({
        id: event.id,
        date: event.date,
        direction: event.direction,
        amount: event.amount === null ? null : money(input.currency, event.amount),
        source: event.source,
      });
    }
    points.push({
      date,
      balance: money(input.currency, balance),
      delta: money(input.currency, delta),
      events,
      unknownEventCount: events.filter((event) => event.amount === null).length,
    });
    previous = date;
  }
  return {
    asOf: input.asOf,
    to: previous,
    months: input.months,
    currency: input.currency,
    startingBalance: money(input.currency, input.startingBalance),
    points,
    confidence:
      unknownEventCount > 0
        ? { level: "medium", reasons: ["evento_variavel_sem_estimativa"] }
        : { level: "high", reasons: ["eventos_projetados_com_valor_conhecido"] },
  };
}

export function calculateSafeToSpendAmounts(input: SafeToSpendCalculationInput): {
  gross: bigint;
  safe: bigint;
} {
  return calculateSafeToSpend(input);
}

export function resolveInsightWindow(input: { asOf: string; from?: string; to?: string }): {
  from: string;
  to: string;
} {
  const parsed = insightWindowQuerySchema.parse(input);
  return {
    from: parsed.from ?? input.asOf,
    to: parsed.to ?? input.asOf,
  };
}

export function resolveReportWindow(input: { asOf: string; from?: string; to?: string }): {
  from: string;
  to: string;
} {
  const parsed = insightReportQuerySchema.parse(input);
  const from = parsed.from ?? `${input.asOf.slice(0, 7)}-01`;
  const to = parsed.to ?? input.asOf;
  if (from > to) throw new FinanceConflictError("O período do relatório é inválido.");
  return { from, to };
}

function reportFilters(input: { kind?: "all" | "income" | "expense"; categoryId?: string }): {
  kind: "all" | "income" | "expense";
  categoryId: string | null;
} {
  return { kind: input.kind ?? "all", categoryId: input.categoryId ?? null };
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
  loanReceivable: bigint;
  loanPayable: bigint;
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
  loan_receivable_minor?: string | bigint | null;
  loan_payable_minor?: string | bigint | null;
  loan_overdue_payable_minor?: string | bigint | null;
  loan_commitment_count?: string | bigint | null;
  reserved_minor?: string | bigint | null;
  missing_count?: string | bigint | null;
  low_count?: string | bigint | null;
}

interface InsightReportRow {
  month?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  income_minor?: string | bigint | null;
  expense_minor?: string | bigint | null;
  transaction_count?: string | bigint | null;
}

interface ProjectionRow {
  id?: string | null;
  event_date?: string | null;
  direction?: "income" | "outflow" | string | null;
  amount_minor?: string | bigint | null;
  source_type?: string | null;
  source_id?: string | null;
  label?: string | null;
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
      const { from, to } = resolveInsightWindow({ ...parsed, asOf });
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

  async getProjection(scope: FinanceScope, input: unknown = {}): Promise<FinancialProjection> {
    const parsed = projectionQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      const config = await this.workspaceConfig(client, scope.workspaceId);
      const asOf = parsed.asOf ?? this.today(config.timezone);
      const parsedAsOf = parseLocalDate(asOf);
      if (!parsedAsOf.ok) throw new FinanceConflictError("A data de referência é inválida.");
      const to = addLocalDateMonths(parsedAsOf.value, parsed.months);
      const snapshot = await this.loadSnapshot(client, scope.workspaceId, config, {
        asOf,
        from: asOf,
        to,
      });
      const rows = await client.query<ProjectionRow>(
        `SELECT projected.id,
                projected.event_date,
                projected.direction,
                projected.amount_minor,
                projected.source_type,
                projected.source_id,
                projected.label
           FROM (
             SELECT ft.id,
                    COALESCE(ft.due_on, ft.occurred_on)::text AS event_date,
                    CASE WHEN ft.kind = 'income' THEN 'income' ELSE 'outflow' END AS direction,
                    CASE
                      WHEN rr.variable = true AND rr.estimated_minor IS NULL THEN NULL
                      WHEN rr.variable = true THEN GREATEST(
                        COALESCE(rr.estimated_minor, ft.amount_minor - ft.settled_minor) - ft.settled_minor,
                        0
                      )
                      ELSE ft.amount_minor - ft.settled_minor
                    END AS amount_minor,
                    CASE
                      WHEN ft.recurrence_id IS NOT NULL THEN 'recurrence'
                      WHEN ft.installment_plan_id IS NOT NULL THEN 'installment'
                      ELSE 'transaction'
                    END AS source_type,
                    COALESCE(ft.recurrence_id, ft.installment_plan_id, ft.id)::text AS source_id,
                    NULLIF(trim(ft.description), '') AS label
               FROM finance_transaction ft
               LEFT JOIN recurrence_rule rr
                 ON rr.workspace_id = ft.workspace_id AND rr.id = ft.recurrence_id
              WHERE ft.workspace_id = $1
                AND ft.currency_code = $2
                AND ft.instrument = 'wallet'
                AND ft.state IN ('planned', 'partially_settled')
                AND COALESCE(ft.due_on, ft.occurred_on) <= $4::date
                AND ft.amount_minor > ft.settled_minor
             UNION ALL
             SELECT cs.id,
                    cs.due_on::text,
                    'outflow',
                    GREATEST(cs.total_minor - cs.paid_minor, 0),
                    'statement',
                    cs.id::text,
                    'Fatura do cartão'
               FROM credit_statement cs
              WHERE cs.workspace_id = $1
                AND cs.state NOT IN ('paid', 'canceled')
                AND cs.due_on <= $4::date
                AND cs.total_minor > cs.paid_minor
             UNION ALL
             SELECT lc.id,
                    lc.due_on::text,
                    CASE WHEN lc.direction = 'lent' THEN 'income' ELSE 'outflow' END,
                    GREATEST(
                      lc.principal_minor - COALESCE((
                        SELECT SUM(lp.amount_minor)
                          FROM loan_payment lp
                         WHERE lp.workspace_id = lc.workspace_id
                           AND lp.loan_id = lc.id
                           AND lp.currency_code = lc.currency_code
                           AND lp.occurred_on <= $3::date
                      ), 0),
                      0
                    ),
                    'loan',
                    lc.id::text,
                    CASE WHEN lc.direction = 'lent' THEN 'Empréstimo concedido' ELSE 'Empréstimo recebido' END
               FROM loan_contract lc
              WHERE lc.workspace_id = $1
                AND lc.currency_code = $2
                AND lc.status = 'open'
                AND lc.due_on <= $4::date
           ) projected
          WHERE projected.amount_minor IS NULL OR projected.amount_minor > 0
          ORDER BY projected.event_date, projected.id`,
        [scope.workspaceId, config.currency, asOf, to],
      );
      const projection = projectCashFlow({
        asOf,
        months: parsed.months,
        currency: config.currency,
        startingBalance: snapshot.balance,
        events: rows.rows.map((row) => ({
          id: row.id ?? "",
          date: row.event_date ?? asOf,
          direction: row.direction === "income" ? "income" : "outflow",
          amount:
            row.amount_minor === null || row.amount_minor === undefined
              ? null
              : toBigInt(row.amount_minor),
          source: {
            type: isProjectionSourceType(row.source_type) ? row.source_type : "transaction",
            id: row.source_id ?? row.id ?? "",
            label: row.label ?? "Compromisso sem descrição",
          },
        })),
      });
      const sourceConfidence = confidenceFor(snapshot);
      const reasons = new Set([
        ...sourceConfidence.reasons,
        ...projection.confidence.reasons.filter(
          (reason) => reason !== "eventos_projetados_com_valor_conhecido",
        ),
      ]);
      return {
        ...projection,
        confidence: {
          level:
            sourceConfidence.level === "low" || projection.confidence.level === "low"
              ? "low"
              : sourceConfidence.level === "medium" || projection.confidence.level === "medium"
                ? "medium"
                : "high",
          reasons: [...reasons],
        },
      };
    });
  }

  async getReport(scope: FinanceScope, input: unknown = {}): Promise<InsightReportView> {
    const parsed = insightReportQuerySchema.parse(input);
    return this.withScopedClient(scope, async (client) => {
      const config = await this.workspaceConfig(client, scope.workspaceId);
      const asOf = parsed.asOf ?? this.today(config.timezone);
      const { from, to } = resolveReportWindow({ ...parsed, asOf });
      const filters = reportFilters(parsed);
      const where = [
        "ft.workspace_id = $1",
        "ft.currency_code = $2",
        "ev.status = 'published'",
        "fa.kind IN ('income', 'expense')",
        "ft.occurred_on BETWEEN $3::date AND $4::date",
        "ft.kind IN ('income', 'expense')",
      ];
      const values: unknown[] = [scope.workspaceId, config.currency, from, to];
      if (filters.kind !== "all") {
        values.push(filters.kind);
        where.push(`ft.kind = $${values.length}`);
      }
      if (filters.categoryId) {
        values.push(filters.categoryId);
        where.push(`ft.category_id = $${values.length}`);
      }
      const baseFrom = `
        FROM finance_transaction ft
        JOIN ledger_event ev
          ON ev.workspace_id = ft.workspace_id AND ev.transaction_id = ft.id
        JOIN ledger_entry le
          ON le.workspace_id = ev.workspace_id AND le.event_id = ev.id
        JOIN financial_account fa
          ON fa.workspace_id = le.workspace_id AND fa.id = le.account_id`;
      const whereSql = `WHERE ${where.join(" AND ")}`;
      const [monthly, categories, totals] = await Promise.all([
        client.query<InsightReportRow>(
          `SELECT to_char(ft.occurred_on, 'YYYY-MM') AS month,
                  COALESCE(SUM(CASE WHEN fa.kind = 'income' THEN -le.amount_minor ELSE 0 END), 0) AS income_minor,
                  COALESCE(SUM(CASE WHEN fa.kind = 'expense' THEN le.amount_minor ELSE 0 END), 0) AS expense_minor,
                  COUNT(DISTINCT ft.id) AS transaction_count
             ${baseFrom}
             ${whereSql}
            GROUP BY to_char(ft.occurred_on, 'YYYY-MM')
            ORDER BY month`,
          values,
        ),
        client.query<InsightReportRow>(
          `SELECT fc.id AS category_id,
                  COALESCE(fc.name, 'Sem categoria') AS category_name,
                  COALESCE(SUM(CASE WHEN fa.kind = 'income' THEN -le.amount_minor ELSE 0 END), 0) AS income_minor,
                  COALESCE(SUM(CASE WHEN fa.kind = 'expense' THEN le.amount_minor ELSE 0 END), 0) AS expense_minor,
                  COUNT(DISTINCT ft.id) AS transaction_count
             ${baseFrom}
             LEFT JOIN finance_category fc
               ON fc.workspace_id = ft.workspace_id AND fc.id = ft.category_id
             ${whereSql}
            GROUP BY fc.id, fc.name
            ORDER BY category_name`,
          values,
        ),
        client.query<InsightReportRow>(
          `SELECT COALESCE(SUM(CASE WHEN fa.kind = 'income' THEN -le.amount_minor ELSE 0 END), 0) AS income_minor,
                  COALESCE(SUM(CASE WHEN fa.kind = 'expense' THEN le.amount_minor ELSE 0 END), 0) AS expense_minor,
                  COUNT(DISTINCT ft.id) AS transaction_count
             ${baseFrom}
             ${whereSql}`,
          values,
        ),
      ]);
      return toInsightReportView({
        asOf,
        from,
        to,
        currency: config.currency,
        filters,
        monthly: monthly.rows,
        categories: categories.rows,
        totals: totals.rows[0],
      });
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
    const loans = await client.query<InsightNumericRow>(
      `SELECT COALESCE(SUM(CASE WHEN projected.direction = 'lent' THEN projected.remaining_minor ELSE 0 END), 0) AS loan_receivable_minor,
              COALESCE(SUM(CASE WHEN projected.direction = 'borrowed' THEN projected.remaining_minor ELSE 0 END), 0) AS loan_payable_minor,
              COALESCE(SUM(CASE WHEN projected.direction = 'borrowed' AND projected.due_on < $3::date THEN projected.remaining_minor ELSE 0 END), 0) AS loan_overdue_payable_minor,
              COUNT(*) AS loan_commitment_count
         FROM (
           SELECT lc.direction,
                  lc.due_on,
                  lc.principal_minor - COALESCE((
                    SELECT SUM(lp.amount_minor)
                      FROM loan_payment lp
                     WHERE lp.workspace_id = lc.workspace_id
                       AND lp.loan_id = lc.id
                       AND lp.currency_code = lc.currency_code
                       AND lp.occurred_on <= $3::date
                  ), 0) AS remaining_minor
             FROM loan_contract lc
            WHERE lc.workspace_id = $1
              AND lc.currency_code = $2
              AND lc.occurred_on <= $3::date
              AND lc.due_on IS NOT NULL
         ) projected
        WHERE projected.due_on <= $4::date
          AND projected.remaining_minor > 0`,
      [workspaceId, config.currency, dates.asOf, dates.to],
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
      `SELECT COUNT(*) FILTER (WHERE marked_missing = true OR quantity_milli = 0) AS missing_count,
              COUNT(*) FILTER (WHERE quantity_milli > 0 AND minimum_milli IS NOT NULL AND quantity_milli <= minimum_milli) AS low_count
         FROM stock_product
        WHERE workspace_id = $1 AND archived = false`,
      [workspaceId],
    );

    const balanceRow = balanceResult.rows[0];
    const resultRow = result.rows[0];
    const commitmentRow = commitment.rows[0];
    const loanRow = loans.rows[0];
    const loanReceivable = toBigInt(loanRow?.loan_receivable_minor);
    const loanPayable = toBigInt(loanRow?.loan_payable_minor);
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
      plannedIncome: toBigInt(commitmentRow?.planned_income_minor) + loanReceivable,
      walletOutflow: toBigInt(commitmentRow?.wallet_outflow_minor),
      cardBills: toBigInt(statements.rows[0]?.card_bills_minor),
      overdueOutflow:
        toBigInt(commitmentRow?.overdue_outflow_minor) +
        toBigInt(loanRow?.loan_overdue_payable_minor),
      loanReceivable,
      loanPayable,
      commitmentCount:
        Number(toBigInt(commitmentRow?.commitment_count)) +
        Number(toBigInt(loanRow?.loan_commitment_count)),
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
      plannedOutflow: money(
        snapshot.config.currency,
        snapshot.walletOutflow + snapshot.cardBills + snapshot.loanPayable,
      ),
      overdueOutflow: money(snapshot.config.currency, snapshot.overdueOutflow),
      walletOutflow: money(snapshot.config.currency, snapshot.walletOutflow),
      cardBills: money(snapshot.config.currency, snapshot.cardBills),
      loanReceivable: money(snapshot.config.currency, snapshot.loanReceivable),
      loanPayable: money(snapshot.config.currency, snapshot.loanPayable),
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

function toInsightReportView(input: {
  asOf: string;
  from: string;
  to: string;
  currency: string;
  filters: { kind: "all" | "income" | "expense"; categoryId: string | null };
  monthly: InsightReportRow[];
  categories: InsightReportRow[];
  totals: InsightReportRow | undefined;
}): InsightReportView {
  const toPeriod = (row: InsightReportRow): InsightReportPeriod => {
    const income = toBigInt(row.income_minor);
    const expense = toBigInt(row.expense_minor);
    return {
      month: row.month ?? "0000-00",
      income: money(input.currency, income),
      expense: money(input.currency, expense),
      net: money(input.currency, income - expense),
      transactionCount: Number(toBigInt(row.transaction_count)),
    };
  };
  const toCategory = (row: InsightReportRow): InsightReportCategory => {
    const income = toBigInt(row.income_minor);
    const expense = toBigInt(row.expense_minor);
    return {
      categoryId: row.category_id ?? null,
      categoryName: row.category_name ?? "Sem categoria",
      income: money(input.currency, income),
      expense: money(input.currency, expense),
      net: money(input.currency, income - expense),
      transactionCount: Number(toBigInt(row.transaction_count)),
    };
  };
  const income = toBigInt(input.totals?.income_minor);
  const expense = toBigInt(input.totals?.expense_minor);
  const totals = {
    income: money(input.currency, income),
    expense: money(input.currency, expense),
    net: money(input.currency, income - expense),
    transactionCount: Number(toBigInt(input.totals?.transaction_count)),
  };
  return {
    asOf: input.asOf,
    from: input.from,
    to: input.to,
    currency: input.currency,
    filters: input.filters,
    totals,
    monthly: input.monthly.map(toPeriod),
    categories: input.categories.map(toCategory),
    reconciliation: {
      source: "published_ledger",
      transactionCount: totals.transactionCount,
      income: totals.income,
      expense: totals.expense,
      export: {
        domain: "transactions",
        format: "csv",
        from: input.from,
        to: input.to,
        kind: input.filters.kind,
        categoryId: input.filters.categoryId,
      },
    },
  };
}

function toSafeToSpendView(snapshot: Snapshot, horizonDays: number): SafeToSpendView {
  const covered = coveredReservations(snapshot.balance, snapshot.reserved);
  const plannedOutflow = snapshot.walletOutflow + snapshot.cardBills + snapshot.loanPayable;
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
      loanReceivable: money(currency, snapshot.loanReceivable),
      loanPayable: money(currency, snapshot.loanPayable),
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

function isProjectionSourceType(
  value: string | null | undefined,
): value is CashFlowProjectionEvent["source"]["type"] {
  return (
    value === "transaction" ||
    value === "recurrence" ||
    value === "installment" ||
    value === "statement" ||
    value === "loan" ||
    value === "goal"
  );
}
