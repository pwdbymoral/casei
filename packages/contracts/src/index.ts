import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "member", "viewer"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Domain identifiers are PostgreSQL UUIDv7 values in lowercase canonical form. */
export const domainIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "ID must be a lowercase UUIDv7",
  );
export const workspaceIdSchema = domainIdSchema;

/** Better Auth user IDs are opaque strings and are not UUIDs. */
export const userIdSchema = z.string().min(1).max(255);

export const workspaceMembershipSchema = z.object({
  userId: userIdSchema,
  workspaceId: workspaceIdSchema,
  role: workspaceRoleSchema,
});

export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

/** Correlation IDs are uppercase ULIDs at the trusted HTTP boundary. */
export const correlationIdSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "correlation ID must be an uppercase ULID");

export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const versionSchema = z.number().int().nonnegative();

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const pageSchema = z.object({
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
});

export const errorCodeSchema = z.enum([
  "malformed_request",
  "validation_failed",
  "unauthenticated",
  "not_found",
  "permission_denied",
  "precondition_required",
  "version_conflict",
  "idempotency_conflict",
  "rate_limited",
  "offline_required",
  "job_not_ready",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    correlationId: correlationIdSchema,
    currentVersion: versionSchema.optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

const civilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
    if (year === 0 || month < 1 || month > 12 || day < 1) return false;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= lastDay;
  }, "date must be a real civil date");

const minorAmountSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/, "minor must be a canonical decimal integer")
  .refine((value) => {
    try {
      return (value.startsWith("-") ? -BigInt(value.slice(1)) : BigInt(value)) <= 999999999999999n;
    } catch {
      return false;
    }
  }, "minor is outside the supported range");

export const moneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  minor: minorAmountSchema,
});

export type MoneyContract = z.infer<typeof moneySchema>;

export const positiveMoneySchema = moneySchema.extend({
  minor: minorAmountSchema.refine((value) => BigInt(value) > 0n, "minor must be greater than zero"),
});

export const transactionKindSchema = z.enum(["income", "expense", "transfer", "adjustment"]);
export const transactionStateSchema = z.enum([
  "planned",
  "partially_settled",
  "posted",
  "canceled",
]);

export const transactionSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  kind: transactionKindSchema,
  state: transactionStateSchema,
  amount: positiveMoneySchema,
  settledAmount: moneySchema,
  occurredOn: civilDateSchema,
  dueOn: civilDateSchema.nullable(),
  postedOn: z.string().datetime({ offset: true }).nullable(),
  description: z.string().max(500),
  categoryId: domainIdSchema.nullable(),
  cardId: domainIdSchema.nullable(),
  statementId: domainIdSchema.nullable(),
  version: versionSchema,
});

export type TransactionContract = z.infer<typeof transactionSchema>;

export const createTransactionSchema = z.object({
  kind: transactionKindSchema,
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
  dueOn: civilDateSchema.nullable().optional(),
  state: z.enum(["planned", "posted"]).default("posted"),
  description: z.string().trim().max(500).default(""),
  categoryId: domainIdSchema.nullable().optional(),
  cardId: domainIdSchema.nullable().optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const categoryKindSchema = z.enum(["income", "expense", "both"]);
export const categorySchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().trim().min(1).max(80),
  kind: categoryKindSchema,
  archived: z.boolean(),
  version: versionSchema,
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: categoryKindSchema,
});

export const creditCardSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().min(1).max(100),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  holder: z.string().max(100).nullable(),
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  limit: moneySchema.nullable(),
  archived: z.boolean(),
  version: versionSchema,
});

export const createCreditCardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  holder: z.string().trim().max(100).nullable().optional(),
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .optional(),
  limit: moneySchema.nullable().optional(),
});

export const statementSchema = z.object({
  id: domainIdSchema,
  cardId: domainIdSchema,
  periodStart: civilDateSchema,
  closingOn: civilDateSchema,
  dueOn: civilDateSchema,
  state: z.enum(["open", "closed", "partially_paid", "paid", "canceled"]),
  total: moneySchema,
  paid: moneySchema,
  openAmount: moneySchema,
  version: versionSchema,
});

export const statementListQuerySchema = z.object({
  cardId: domainIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const closeStatementSchema = z.object({
  /** Closing is a command, but the body is kept explicit for future audit metadata. */
  confirm: z.literal(true),
});

export const reopenStatementSchema = z.object({
  /** Reopening changes the cycle that receives future purchases and must be explicit. */
  confirm: z.literal(true),
});

export const statementItemSchema = z.object({
  id: domainIdSchema,
  transactionId: domainIdSchema,
  statementId: domainIdSchema,
  type: z.enum(["purchase", "payment"]),
  state: z.enum(["planned", "partially_settled", "posted", "canceled"]),
  description: z.string(),
  occurredOn: civilDateSchema,
  amount: moneySchema,
});

export const payStatementSchema = z.object({
  amount: positiveMoneySchema.optional(),
  occurredOn: civilDateSchema.optional(),
  allowCredit: z.boolean().default(false),
});

export const createRecurrenceSchema = z.object({
  kind: z.enum(["income", "expense"]),
  amount: positiveMoneySchema,
  frequency: z.enum(["weekly", "monthly", "annual"]),
  interval: z.number().int().min(1).max(12).default(1),
  startOn: civilDateSchema,
  endOn: civilDateSchema.nullable().optional(),
  maxOccurrences: z.number().int().min(1).max(120).nullable().optional(),
  variable: z.boolean().default(false),
  estimatedAmount: positiveMoneySchema.nullable().optional(),
  description: z.string().trim().max(500).default(""),
});

export const createInstallmentPlanSchema = z.object({
  total: positiveMoneySchema,
  count: z.number().int().min(2).max(999),
  firstDueOn: civilDateSchema,
  description: z.string().trim().max(500).default(""),
});
