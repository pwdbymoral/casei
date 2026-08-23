import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
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
  createdAt: instant("created_at").defaultNow().notNull(),
  updatedAt: instant("updated_at").defaultNow().notNull(),
});

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
  },
  (table) => [
    index("audit_event_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("audit_event_actor_occurred_idx").on(table.actorId, table.occurredAt),
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

export const schema = {
  workspace,
  workspacePreference,
  membership,
  auditEvent,
  idempotencyKey,
  outboxEvent,
  job,
  authEmailIntent,
  authEmailOutbox,
};
