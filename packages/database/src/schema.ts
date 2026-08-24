import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export * from "./generated-auth-schema.js";

import { user } from "./generated-auth-schema.js";

const instant = (name: string) => timestamp(name, { withTimezone: true });

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    check(
      "workspace_status_check",
      sql`${table.status} in ('active', 'deletion_pending', 'deactivated')`,
    ),
  ],
);

export const workspacePreference = pgTable("workspace_preference", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  currencyCode: varchar("currency_code", { length: 3 }).notNull(),
  timezone: text("timezone").notNull(),
  safetyMarginMinor: bigint("safety_margin_minor", { mode: "bigint" }).notNull().default(sql`0`),
  initialBalanceMinor: bigint("initial_balance_minor", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  onboardingCompletedAt: instant("onboarding_completed_at"),
  createdAt: instant("created_at").defaultNow().notNull(),
  updatedAt: instant("updated_at").defaultNow().notNull(),
});

export const userPreference = pgTable(
  "user_preference",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    locale: text("locale").notNull().default("pt-BR"),
    hideValues: boolean("hide_values").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("user_preference_locale_check", sql`${table.locale} = 'pt-BR'`),
    check("user_preference_version_check", sql`${table.version} >= 0`),
  ],
);

export const workspaceInvitation = pgTable(
  "workspace_invitation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    expiresAt: instant("expires_at").notNull(),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    acceptedAt: instant("accepted_at"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("workspace_invitation_token_unique").on(table.tokenHash),
    index("workspace_invitation_workspace_status_idx").on(table.workspaceId, table.status),
    index("workspace_invitation_email_idx").on(table.email, table.status),
    uniqueIndex("workspace_invitation_pending_email_unique")
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'pending'`),
    check("workspace_invitation_role_check", sql`${table.role} in ('member', 'viewer')`),
    check(
      "workspace_invitation_status_check",
      sql`${table.status} in ('pending', 'accepted', 'revoked', 'expired')`,
    ),
  ],
);

export const workspaceDeletionRecovery = pgTable(
  "workspace_deletion_recovery",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    entitlement: text("entitlement").notNull().default("workspace_deletion_recovery"),
    status: text("status").notNull().default("active"),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    canceledAt: instant("canceled_at"),
  },
  (table) => [
    uniqueIndex("workspace_deletion_recovery_active_unique")
      .on(table.workspaceId)
      .where(sql`${table.status} = 'active'`),
    index("workspace_deletion_recovery_owner_idx").on(table.ownerUserId, table.status),
    check(
      "workspace_deletion_recovery_status_check",
      sql`${table.status} in ('active', 'canceled', 'expired')`,
    ),
  ],
);

export const workspaceTombstone = pgTable(
  "workspace_tombstone",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    pseudonymousOwnerHash: text("pseudonymous_owner_hash").notNull(),
    status: text("status").notNull().default("deactivated"),
    deactivatedAt: instant("deactivated_at").notNull(),
    purgeAt: instant("purge_at").notNull(),
    backupExpiresAt: instant("backup_expires_at").notNull(),
    auditPurgeAt: instant("audit_purge_at").notNull(),
  },
  (table) => [check("workspace_tombstone_status_check", sql`${table.status} = 'deactivated'`)],
);

export const workspaceInvitationRateLimit = pgTable(
  "workspace_invitation_rate_limit",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    windowStartedAt: instant("window_started_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.actorUserId, table.action] }),
    index("workspace_invitation_rate_limit_window_idx").on(table.windowStartedAt),
    check(
      "workspace_invitation_rate_limit_action_check",
      sql`${table.action} in ('create', 'resend')`,
    ),
    check("workspace_invitation_rate_limit_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("membership_workspace_user_unique").on(table.workspaceId, table.userId),
    index("membership_user_idx").on(table.userId),
    check("membership_role_check", sql`${table.role} in ('owner', 'member', 'viewer')`),
    check(
      "membership_status_check",
      sql`${table.status} in ('active', 'revoked', 'recovery_only')`,
    ),
  ],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    category: text("category").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    workspaceId: uuid("workspace_id").references(() => workspace.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    occurredAt: instant("occurred_at").defaultNow().notNull(),
    origin: text("origin").notNull(),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    result: text("result").notNull(),
    reason: text("reason"),
    retentionUntil: instant("retention_until"),
    beforeRedacted: jsonb("before_redacted"),
    afterRedacted: jsonb("after_redacted"),
  },
  (table) => [
    index("audit_event_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("audit_event_actor_occurred_idx").on(table.actorId, table.occurredAt),
    index("audit_event_retention_idx").on(table.retentionUntil),
  ],
);

export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    scope: text("scope").notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: smallint("status_code"),
    response: jsonb("response"),
    createdAt: instant("created_at").defaultNow().notNull(),
    expiresAt: instant("expires_at").notNull(),
  },
  (table) => [uniqueIndex("idempotency_scope_key_unique").on(table.scope, table.key)],
);

export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, {
      onDelete: "set null",
    }),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    requiredCapability: text("required_capability"),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    availableAt: instant("available_at").defaultNow().notNull(),
    attempts: integer("attempts").notNull().default(0),
    publishedAt: instant("published_at"),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("outbox_pending_idx").on(table.status, table.availableAt),
    check("outbox_status_check", sql`${table.status} in ('pending', 'published', 'dead')`),
  ],
);

export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    jobType: text("job_type").notNull(),
    jobVersion: integer("job_version").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, {
      onDelete: "set null",
    }),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    requiredCapability: text("required_capability"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    state: text("state").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    availableAt: instant("available_at").defaultNow().notNull(),
    leaseUntil: instant("lease_until"),
    leaseToken: text("lease_token"),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    lastError: text("last_error"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("job_type_idempotency_unique").on(table.jobType, table.idempotencyKey),
    index("job_claim_idx").on(table.state, table.availableAt, table.priority),
    check(
      "job_state_check",
      sql`${table.state} in ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled')`,
    ),
  ],
);

export const authEmailIntent = pgTable(
  "auth_email_intent",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind").notNull(),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    emailHash: text("email_hash").notNull(),
    callbackUrl: text("callback_url").notNull(),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("auth_email_intent_pending_idx").on(table.state, table.expiresAt),
    check(
      "auth_email_intent_state_check",
      sql`${table.state} in ('pending', 'queued', 'sent', 'failed', 'expired')`,
    ),
  ],
);

export const authEmailOutbox = pgTable(
  "auth_email_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => authEmailIntent.id, { onDelete: "cascade" }),
    messageKind: text("message_kind").notNull(),
    sourceId: text("source_id").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: instant("available_at").defaultNow().notNull(),
    sentAt: instant("sent_at"),
    lastError: text("last_error"),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("auth_email_outbox_source_unique").on(table.messageKind, table.sourceId),
    index("auth_email_outbox_pending_idx").on(table.state, table.availableAt),
    check("auth_email_outbox_state_check", sql`${table.state} in ('pending', 'sent', 'failed')`),
  ],
);

export const financialAccount = pgTable(
  "financial_account",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    archived: boolean("archived").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("financial_account_workspace_id_id_currency_unique").on(
      table.workspaceId,
      table.id,
      table.currencyCode,
    ),
    uniqueIndex("financial_account_workspace_kind_name_unique").on(
      table.workspaceId,
      table.kind,
      table.name,
    ),
    check(
      "financial_account_kind_check",
      sql`${table.kind} in ('wallet', 'card_liability', 'income', 'expense', 'adjustment', 'loan_receivable', 'loan_payable')`,
    ),
    check("financial_account_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

export const financeCategory = pgTable(
  "finance_category",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    archived: boolean("archived").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("finance_category_active_name_unique").on(table.workspaceId, table.name),
    uniqueIndex("finance_category_workspace_id_id_unique").on(table.workspaceId, table.id),
    check("finance_category_kind_check", sql`${table.kind} in ('income', 'expense', 'both')`),
  ],
);

export const ledgerEvent = pgTable(
  "ledger_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id"),
    eventType: text("event_type").notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    status: text("status").notNull().default("draft"),
    occurredOn: date("occurred_on").notNull(),
    publishedAt: instant("published_at"),
    reversedEventId: uuid("reversed_event_id"),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ledger_event_id_currency_unique").on(table.id, table.currencyCode),
    uniqueIndex("ledger_event_transaction_type_unique").on(table.transactionId, table.eventType),
    check("ledger_event_status_check", sql`${table.status} in ('draft', 'published', 'reversed')`),
    check("ledger_event_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => ledgerEvent.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => financialAccount.id, { onDelete: "restrict" }),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("ledger_entry_amount_nonzero_check", sql`${table.amountMinor} <> 0`),
    check("ledger_entry_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    uniqueIndex("ledger_entry_event_account_unique").on(table.eventId, table.accountId),
  ],
);

export const financeTransaction = pgTable(
  "finance_transaction",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("planned"),
    instrument: text("instrument").notNull().default("wallet"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    settledMinor: bigint("settled_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    dueOn: date("due_on"),
    postedOn: instant("posted_on"),
    cashSettledOn: instant("cash_settled_on"),
    description: text("description").notNull().default(""),
    categoryId: uuid("category_id"),
    cardId: uuid("card_id"),
    statementId: uuid("statement_id"),
    recurrenceId: uuid("recurrence_id"),
    installmentPlanId: uuid("installment_plan_id"),
    installmentNumber: integer("installment_number"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "finance_transaction_kind_check",
      sql`${table.kind} in ('income', 'expense', 'transfer', 'adjustment')`,
    ),
    check(
      "finance_transaction_state_check",
      sql`${table.state} in ('planned', 'partially_settled', 'posted', 'canceled')`,
    ),
    check("finance_transaction_instrument_check", sql`${table.instrument} in ('wallet', 'card')`),
    check(
      "finance_transaction_amount_check",
      sql`${table.amountMinor} > 0 and ${table.settledMinor} >= 0 and ${table.settledMinor} <= ${table.amountMinor}`,
    ),
    check("finance_transaction_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    uniqueIndex("finance_transaction_workspace_id_id_unique").on(table.workspaceId, table.id),
  ],
);

export const recurrenceRule = pgTable(
  "recurrence_rule",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    frequency: text("frequency").notNull(),
    interval: integer("interval").notNull().default(1),
    startOn: date("start_on").notNull(),
    endOn: date("end_on"),
    maxOccurrences: integer("max_occurrences"),
    variable: boolean("variable").notNull().default(false),
    estimatedMinor: bigint("estimated_minor", { mode: "bigint" }),
    pausedOn: date("paused_on"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("recurrence_frequency_check", sql`${table.frequency} in ('weekly', 'monthly', 'annual')`),
    check("recurrence_interval_check", sql`${table.interval} > 0`),
  ],
);

export const recurrenceOccurrence = pgTable(
  "recurrence_occurrence",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    recurrenceId: uuid("recurrence_id")
      .notNull()
      .references(() => recurrenceRule.id, { onDelete: "restrict" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => financeTransaction.id, { onDelete: "restrict" }),
    occurrenceOn: date("occurrence_on").notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("recurrence_occurrence_natural_unique").on(table.recurrenceId, table.occurrenceOn),
  ],
);

export const installmentPlan = pgTable(
  "installment_plan",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    count: integer("count").notNull(),
    firstDueOn: date("first_due_on").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("installment_plan_total_check", sql`${table.totalMinor} > 0`),
    check("installment_plan_count_check", sql`${table.count} between 2 and 999`),
  ],
);

export const installment = pgTable(
  "installment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => installmentPlan.id, { onDelete: "restrict" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => financeTransaction.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    dueOn: date("due_on").notNull(),
  },
  (table) => [
    uniqueIndex("installment_plan_number_unique").on(table.planId, table.number),
    check("installment_number_check", sql`${table.number} > 0`),
  ],
);

export const creditCard = pgTable(
  "credit_card",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    closingDay: smallint("closing_day").notNull(),
    dueDay: smallint("due_day").notNull(),
    holder: text("holder"),
    lastFour: varchar("last_four", { length: 4 }),
    limitMinor: bigint("limit_minor", { mode: "bigint" }),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    archived: boolean("archived").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("credit_card_closing_day_check", sql`${table.closingDay} between 1 and 31`),
    check("credit_card_due_day_check", sql`${table.dueDay} between 1 and 31`),
    check(
      "credit_card_last_four_check",
      sql`${table.lastFour} is null or ${table.lastFour} ~ '^[0-9]{4}$'`,
    ),
  ],
);

export const creditStatement = pgTable(
  "credit_statement",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => creditCard.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    closingOn: date("closing_on").notNull(),
    dueOn: date("due_on").notNull(),
    state: text("state").notNull().default("open"),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull().default(sql`0`),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("credit_statement_card_closing_unique").on(table.cardId, table.closingOn),
    uniqueIndex("credit_statement_workspace_id_id_unique").on(table.workspaceId, table.id),
    check(
      "credit_statement_state_check",
      sql`${table.state} in ('open', 'closed', 'partially_paid', 'paid', 'canceled')`,
    ),
    check(
      "credit_statement_amount_check",
      sql`${table.totalMinor} >= 0 and ${table.paidMinor} >= 0`,
    ),
  ],
);

export const cardPayment = pgTable(
  "card_payment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => creditStatement.id, { onDelete: "restrict" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => financeTransaction.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("card_payment_amount_check", sql`${table.amountMinor} > 0`),
    uniqueIndex("card_payment_transaction_unique").on(table.transactionId),
  ],
);

export const schema = {
  workspace,
  workspacePreference,
  userPreference,
  membership,
  auditEvent,
  idempotencyKey,
  outboxEvent,
  job,
  authEmailIntent,
  authEmailOutbox,
  financialAccount,
  financeCategory,
  ledgerEvent,
  ledgerEntry,
  financeTransaction,
  recurrenceRule,
  recurrenceOccurrence,
  installmentPlan,
  installment,
  creditCard,
  creditStatement,
  cardPayment,
};
