import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
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

/** Global platform authority is separate from workspace memberships. */
export const platformAccount = pgTable(
  "platform_account",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role"),
    status: text("status").notNull().default("active"),
    suspensionReason: text("suspension_reason"),
    roleChangeReason: text("role_change_reason"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("platform_account_role_status_idx").on(table.role, table.status),
    check(
      "platform_account_role_check",
      sql`${table.role} is null or ${table.role} in ('platform_admin', 'platform_support')`,
    ),
    check("platform_account_status_check", sql`${table.status} in ('active', 'suspended')`),
    check("platform_account_version_check", sql`${table.version} >= 0`),
  ],
);

/** Administrative audit has no workspace scope and stores no domestic content. */
export const platformAuditEvent = pgTable(
  "platform_audit_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    targetId: text("target_id"),
    action: text("action").notNull(),
    occurredAt: instant("occurred_at").defaultNow().notNull(),
    origin: text("origin").notNull(),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    result: text("result").notNull(),
    reason: text("reason").notNull(),
  },
  (table) => [
    index("platform_audit_actor_occurred_idx").on(table.actorId, table.occurredAt),
    index("platform_audit_target_occurred_idx").on(table.targetId, table.occurredAt),
  ],
);

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
    beforeRedacted: jsonb("before_redacted"),
    afterRedacted: jsonb("after_redacted"),
    retentionUntil: instant("retention_until"),
  },
  (table) => [
    index("audit_event_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("audit_event_actor_occurred_idx").on(table.actorId, table.occurredAt),
    index("audit_event_retention_idx").on(table.retentionUntil),
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
    goalId: uuid("goal_id"),
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
    uniqueIndex("finance_transaction_recurrence_date_unique")
      .on(table.workspaceId, table.recurrenceId, table.occurredOn)
      .where(sql`${table.recurrenceId} is not null`),
  ],
);

export const workspacePreference = pgTable(
  "workspace_preference",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspace.id, { onDelete: "cascade" }),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    timezone: text("timezone").notNull(),
    safetyMarginMinor: bigint("safety_margin_minor", { mode: "bigint" }).notNull().default(sql`0`),
    initialBalanceMinor: bigint("initial_balance_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    initialBalanceMaterializedAt: instant("initial_balance_materialized_at"),
    initialBalanceTransactionId: uuid("initial_balance_transaction_id"),
    onboardingCompletedAt: instant("onboarding_completed_at"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "workspace_preference_initial_balance_transaction_fk",
      columns: [table.workspaceId, table.initialBalanceTransactionId],
      foreignColumns: [financeTransaction.workspaceId, financeTransaction.id],
    }).onDelete("restrict"),
  ],
);

export const stockProduct = pgTable(
  "stock_product",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    unit: text("unit").notNull().default("unit"),
    unitLabel: text("unit_label"),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }),
    minimumMilli: bigint("minimum_milli", { mode: "bigint" }),
    markedMissing: boolean("marked_missing").notNull().default(false),
    shoppingAuto: boolean("shopping_auto").notNull().default(true),
    category: text("category"),
    location: text("location"),
    note: text("note"),
    archived: boolean("archived").notNull().default(false),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stock_product_workspace_id_unique").on(table.workspaceId, table.id),
    check("stock_product_name_check", sql`length(trim(${table.name})) > 0`),
    check(
      "stock_product_unit_check",
      sql`${table.unit} in ('unit', 'package', 'box', 'kg', 'g', 'L', 'ml', 'other')`,
    ),
    check(
      "stock_product_other_unit_label_check",
      sql`${table.unit} <> 'other' or (${table.unitLabel} is not null and length(trim(${table.unitLabel})) > 0)`,
    ),
    check(
      "stock_product_quantity_check",
      sql`${table.quantityMilli} is null or (${table.quantityMilli} >= 0 and ${table.quantityMilli} <= 999999999999999)`,
    ),
    check(
      "stock_product_minimum_check",
      sql`${table.minimumMilli} is null or (${table.minimumMilli} >= 0 and ${table.minimumMilli} <= 999999999999999)`,
    ),
  ],
);

export const shoppingItem = pgTable(
  "shopping_item",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    productId: uuid("product_id"),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    source: text("source").notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }),
    unit: text("unit").notNull().default("unit"),
    unitLabel: text("unit_label"),
    note: text("note"),
    purchased: boolean("purchased").notNull().default(false),
    purchasedAt: instant("purchased_at"),
    purchasedBy: text("purchased_by").references(() => user.id, { onDelete: "restrict" }),
    expenseTransactionId: uuid("expense_transaction_id"),
    lastChangedBy: text("last_changed_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shopping_item_workspace_id_id_unique").on(table.workspaceId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.productId],
      foreignColumns: [stockProduct.workspaceId, stockProduct.id],
      name: "shopping_item_product_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.expenseTransactionId],
      foreignColumns: [financeTransaction.workspaceId, financeTransaction.id],
      name: "shopping_item_expense_transaction_scope_fk",
    }).onDelete("restrict"),
    check("shopping_item_name_check", sql`length(trim(${table.name})) > 0`),
    check("shopping_item_source_check", sql`${table.source} in ('automatic', 'free')`),
    check(
      "shopping_item_unit_check",
      sql`${table.unit} in ('unit', 'package', 'box', 'kg', 'g', 'L', 'ml', 'other')`,
    ),
    check(
      "shopping_item_other_unit_label_check",
      sql`${table.unit} <> 'other' or (${table.unitLabel} is not null and length(trim(${table.unitLabel})) > 0)`,
    ),
    check(
      "shopping_item_quantity_check",
      sql`${table.quantityMilli} is null or (${table.quantityMilli} >= 0 and ${table.quantityMilli} <= 999999999999999)`,
    ),
    check(
      "shopping_item_source_product_check",
      sql`(${table.source} = 'automatic' and ${table.productId} is not null) or (${table.source} = 'free' and ${table.productId} is null)`,
    ),
    check(
      "shopping_item_purchased_check",
      sql`(${table.purchased} = false and ${table.purchasedAt} is null) or (${table.purchased} = true and ${table.purchasedAt} is not null)`,
    ),
    check("shopping_item_version_check", sql`${table.version} >= 0`),
    uniqueIndex("shopping_item_active_name_unique")
      .on(table.workspaceId, table.nameNormalized)
      .where(sql`${table.purchased} = false`),
    index("shopping_item_active_order_idx").on(
      table.workspaceId,
      table.purchased,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const shoppingItemEvent = pgTable(
  "shopping_item_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    itemId: uuid("item_id").notNull(),
    kind: text("kind").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: instant("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.itemId],
      foreignColumns: [shoppingItem.workspaceId, shoppingItem.id],
      name: "shopping_item_event_item_scope_fk",
    }).onDelete("cascade"),
    check("shopping_item_event_kind_check", sql`${table.kind} in ('created', 'purchased')`),
    index("shopping_item_event_item_occurred_idx").on(
      table.workspaceId,
      table.itemId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const stockMovement = pgTable(
  "stock_movement",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    kind: text("kind").notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }).notNull(),
    beforeMilli: bigint("before_milli", { mode: "bigint" }),
    afterMilli: bigint("after_milli", { mode: "bigint" }),
    reason: text("reason"),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    occurredAt: instant("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.productId],
      foreignColumns: [stockProduct.workspaceId, stockProduct.id],
      name: "stock_movement_product_scope_fk",
    }).onDelete("cascade"),
    check(
      "stock_movement_kind_check",
      sql`${table.kind} in ('entry', 'consume', 'correction', 'discard')`,
    ),
    check(
      "stock_movement_quantity_check",
      sql`${table.quantityMilli} >= 0 and ${table.quantityMilli} <= 999999999999999`,
    ),
    check(
      "stock_movement_before_check",
      sql`${table.beforeMilli} is null or (${table.beforeMilli} >= 0 and ${table.beforeMilli} <= 999999999999999)`,
    ),
    check(
      "stock_movement_after_check",
      sql`${table.afterMilli} is null or (${table.afterMilli} >= 0 and ${table.afterMilli} <= 999999999999999)`,
    ),
    index("stock_movement_product_occurred_idx").on(
      table.workspaceId,
      table.productId,
      table.occurredAt,
    ),
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

export const importJob = pgTable(
  "import_job",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    // Immutable audit provenance; authorization is revalidated separately at each batch.
    actorId: text("actor_id").notNull(),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requiredCapability: text("required_capability").notNull().default("import"),
    domain: text("domain").notNull(),
    storageKey: text("storage_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    previewHash: text("preview_hash").notNull(),
    previewManifest: jsonb("preview_manifest").$type<unknown[]>().notNull(),
    mode: text("mode").notNull(),
    duplicatePolicy: text("duplicate_policy").notNull(),
    acceptedDuplicateLines: jsonb("accepted_duplicate_lines")
      .$type<number[]>()
      .notNull()
      .default([]),
    totalRows: integer("total_rows").notNull(),
    validRows: integer("valid_rows").notNull(),
    duplicateRows: integer("duplicate_rows").notNull(),
    invalidRows: integer("invalid_rows").notNull(),
    appliedRows: integer("applied_rows").notNull().default(0),
    skippedRows: integer("skipped_rows").notNull().default(0),
    rejectedRows: integer("rejected_rows").notNull().default(0),
    cursor: integer("cursor").notNull().default(0),
    batchSize: integer("batch_size").notNull().default(100),
    state: text("state").notNull().default("queued"),
    expiresAt: instant("expires_at").notNull(),
    version: integer("version").notNull().default(0),
    correlationId: varchar("correlation_id", { length: 26 }).notNull(),
    lastError: text("last_error"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("import_job_workspace_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("import_job_workspace_id_unique").on(table.workspaceId, table.id),
    index("import_job_workspace_state_idx").on(
      table.workspaceId,
      table.state,
      table.updatedAt,
      table.id,
    ),
    check("import_job_domain_check", sql`${table.domain} in ('transactions', 'products', 'full')`),
    check("import_job_capability_check", sql`${table.requiredCapability} = 'import'`),
    check("import_job_mode_check", sql`${table.mode} in ('valid_only', 'all_or_nothing')`),
    check(
      "import_job_duplicate_policy_check",
      sql`${table.duplicatePolicy} in ('skip', 'import', 'review')`,
    ),
    check(
      "import_job_state_check",
      sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'reversing', 'reversed')`,
    ),
    check(
      "import_job_counts_check",
      sql`${table.totalRows} between 1 and 50000 and ${table.validRows} >= 0 and ${table.duplicateRows} >= 0 and ${table.invalidRows} >= 0 and ${table.totalRows} = ${table.validRows} + ${table.duplicateRows} + ${table.invalidRows} and ${table.appliedRows} >= 0 and ${table.skippedRows} >= 0 and ${table.rejectedRows} >= 0 and ${table.cursor} between 0 and ${table.totalRows}`,
    ),
    check("import_job_batch_size_check", sql`${table.batchSize} between 1 and 50000`),
    check("import_job_version_check", sql`${table.version} >= 0`),
    check(
      "import_job_duplicate_lines_check",
      sql`jsonb_typeof(${table.acceptedDuplicateLines}) = 'array'`,
    ),
    check(
      "import_job_preview_manifest_check",
      sql`jsonb_typeof(${table.previewManifest}) = 'array'`,
    ),
  ],
);

export const importJobLine = pgTable(
  "import_job_line",
  {
    jobId: uuid("job_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    status: text("status").notNull().default("pending"),
    fingerprint: text("fingerprint"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    reversalToken: text("reversal_token"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.lineNumber] }),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [importJob.workspaceId, importJob.id],
      name: "import_job_line_job_fk",
    }).onDelete("cascade"),
    index("import_job_line_workspace_status_idx").on(
      table.workspaceId,
      table.jobId,
      table.status,
      table.lineNumber,
    ),
    check("import_job_line_number_check", sql`${table.lineNumber} between 2 and 50001`),
    check(
      "import_job_line_status_check",
      sql`${table.status} in ('pending', 'applied', 'skipped', 'rejected', 'reversed')`,
    ),
    check(
      "import_job_line_error_check",
      sql`(${table.status} in ('rejected', 'skipped') and ${table.errorCode} is not null) or ${table.status} in ('pending', 'applied', 'reversed')`,
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
    uniqueIndex("ledger_event_transaction_type_unique")
      .on(table.transactionId, table.eventType)
      .where(
        sql`${table.transactionId} is not null and ${table.eventType} <> 'transaction.partially_settled.v1'`,
      ),
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

export const loanContract = pgTable(
  "loan_contract",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    counterparty: text("counterparty").notNull(),
    principalMinor: bigint("principal_minor", { mode: "bigint" }).notNull(),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    dueOn: date("due_on"),
    principalEventId: uuid("principal_event_id").notNull(),
    status: text("status").notNull().default("open"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("loan_contract_workspace_id_id_unique").on(table.workspaceId, table.id),
    index("loan_contract_workspace_status_due_idx").on(
      table.workspaceId,
      table.status,
      table.dueOn,
      table.occurredOn,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.principalEventId, table.currencyCode],
      foreignColumns: [ledgerEvent.workspaceId, ledgerEvent.id, ledgerEvent.currencyCode],
      name: "loan_contract_principal_event_fk",
    }).onDelete("cascade"),
    check("loan_contract_direction_check", sql`${table.direction} in ('lent', 'borrowed')`),
    check(
      "loan_contract_counterparty_check",
      sql`length(trim(${table.counterparty})) between 1 and 200`,
    ),
    check(
      "loan_contract_principal_check",
      sql`${table.principalMinor} > 0 and ${table.paidMinor} >= 0 and ${table.paidMinor} <= ${table.principalMinor}`,
    ),
    check("loan_contract_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "loan_contract_date_order_check",
      sql`${table.dueOn} is null or ${table.dueOn} >= ${table.occurredOn}`,
    ),
    check("loan_contract_status_check", sql`${table.status} in ('open', 'settled')`),
    check(
      "loan_contract_status_amount_check",
      sql`(${table.status} = 'open' and ${table.paidMinor} < ${table.principalMinor}) or (${table.status} = 'settled' and ${table.paidMinor} = ${table.principalMinor})`,
    ),
    check("loan_contract_version_check", sql`${table.version} >= 0`),
  ],
);

export const loanPayment = pgTable(
  "loan_payment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    loanId: uuid("loan_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    occurredOn: date("occurred_on").notNull(),
    ledgerEventId: uuid("ledger_event_id").notNull(),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("loan_payment_workspace_id_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("loan_payment_event_unique").on(table.workspaceId, table.ledgerEventId),
    foreignKey({
      columns: [table.workspaceId, table.loanId],
      foreignColumns: [loanContract.workspaceId, loanContract.id],
      name: "loan_payment_loan_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.ledgerEventId, table.currencyCode],
      foreignColumns: [ledgerEvent.workspaceId, ledgerEvent.id, ledgerEvent.currencyCode],
      name: "loan_payment_event_fk",
    }).onDelete("cascade"),
    check("loan_payment_amount_check", sql`${table.amountMinor} > 0`),
    check("loan_payment_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

export const goal = pgTable(
  "goal",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetMinor: bigint("target_minor", { mode: "bigint" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    deadline: date("deadline"),
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("active"),
    note: text("note"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("goal_workspace_id_id_unique").on(table.workspaceId, table.id),
    index("goal_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.deadline,
      table.id,
    ),
    check("goal_name_check", sql`length(trim(${table.name})) > 0`),
    check("goal_target_check", sql`${table.targetMinor} > 0`),
    check("goal_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check("goal_priority_check", sql`${table.priority} in ('low', 'normal', 'high')`),
    check(
      "goal_status_check",
      sql`${table.status} in ('active', 'completed', 'paused', 'canceled')`,
    ),
    check("goal_version_check", sql`${table.version} >= 0`),
  ],
);

export const goalReservationMovement = pgTable(
  "goal_reservation_movement",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    kind: text("kind").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    transactionId: uuid("transaction_id"),
    occurredOn: date("occurred_on").notNull(),
    note: text("note"),
    createdAt: instant("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.goalId],
      foreignColumns: [goal.workspaceId, goal.id],
      name: "goal_reservation_movement_goal_scope_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workspaceId, table.transactionId],
      foreignColumns: [financeTransaction.workspaceId, financeTransaction.id],
      name: "goal_reservation_movement_transaction_scope_fk",
    }).onDelete("restrict"),
    uniqueIndex("goal_reservation_movement_workspace_id_id_unique").on(table.workspaceId, table.id),
    index("goal_reservation_movement_goal_occurred_idx").on(
      table.workspaceId,
      table.goalId,
      table.occurredOn,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("goal_reservation_movement_spend_transaction_unique")
      .on(table.transactionId)
      .where(sql`${table.kind} = 'spend'`),
    check(
      "goal_reservation_movement_kind_check",
      sql`${table.kind} in ('allocate', 'release', 'spend')`,
    ),
    check("goal_reservation_movement_amount_check", sql`${table.amountMinor} > 0`),
    check("goal_reservation_movement_currency_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "goal_reservation_movement_transaction_check",
      sql`(${table.kind} = 'spend' and ${table.transactionId} is not null) or (${table.kind} <> 'spend' and ${table.transactionId} is null)`,
    ),
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
    kind: text("kind").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    invalidReason: text("invalid_reason"),
    pausedOn: date("paused_on"),
    version: integer("version").notNull().default(0),
    createdAt: instant("created_at").defaultNow().notNull(),
    updatedAt: instant("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("recurrence_frequency_check", sql`${table.frequency} in ('weekly', 'monthly', 'annual')`),
    check("recurrence_interval_check", sql`${table.interval} > 0`),
    check("recurrence_status_check", sql`${table.status} in ('active', 'archived')`),
    check(
      "recurrence_kind_check",
      sql`${table.status} = 'archived' or ${table.kind} in ('income', 'expense')`,
    ),
    check("recurrence_amount_check", sql`${table.status} = 'archived' or ${table.amountMinor} > 0`),
    check(
      "recurrence_date_order_check",
      sql`${table.status} = 'archived' or ${table.endOn} is null or ${table.endOn} >= ${table.startOn}`,
    ),
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
  stockProduct,
  stockMovement,
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
  loanContract,
  loanPayment,
  goal,
  goalReservationMovement,
  recurrenceRule,
  recurrenceOccurrence,
  installmentPlan,
  installment,
  creditCard,
  creditStatement,
  cardPayment,
};
