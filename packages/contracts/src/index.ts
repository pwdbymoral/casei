import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "member", "viewer"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const versionSchema = z.number().int().nonnegative();

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

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code");

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1).max(200),
  role: workspaceRoleSchema,
  locale: z.literal("pt-BR"),
  timeZone: z.string().min(1).max(64),
  currency: currencyCodeSchema,
  status: z.enum(["active", "deletion_pending", "deactivated"]).default("active"),
  version: z.number().int().nonnegative().default(0),
});
export type WorkspaceSummaryContract = z.infer<typeof workspaceSummarySchema>;

export const workspaceSessionSchema = z.object({
  user: z.object({
    id: userIdSchema,
    displayName: z.string().min(1).max(200),
    email: z.string().email(),
  }),
  workspaces: z.array(workspaceSummarySchema),
});
export type WorkspaceSessionContract = z.infer<typeof workspaceSessionSchema>;

export const localeSchema = z.literal("pt-BR");
export const userProfileSchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(200),
  email: z.string().email(),
  emailVerified: z.boolean(),
  locale: localeSchema,
  hideValues: z.boolean(),
  version: versionSchema,
});
export type UserProfileContract = z.infer<typeof userProfileSchema>;

export const updateUserProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(200),
  locale: localeSchema,
  hideValues: z.boolean(),
});
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;

const safetyMarginMinorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 999999999999999n, "margem fora do limite suportado");

export const workspacePreferencesSchema = z.object({
  workspaceId: workspaceIdSchema,
  name: z.string().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timeZone: z.string().min(1).max(64),
  safetyMarginMinor: safetyMarginMinorSchema,
  version: versionSchema,
});
export type WorkspacePreferencesContract = z.infer<typeof workspacePreferencesSchema>;

export const updateWorkspacePreferencesSchema = z.object({
  name: z.string().trim().min(2).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timeZone: z.string().trim().min(1).max(64),
  safetyMarginMinor: safetyMarginMinorSchema,
});
export type UpdateWorkspacePreferencesInput = z.infer<typeof updateWorkspacePreferencesSchema>;

export const onboardingSchema = z.object({
  displayName: z.string().trim().min(2).max(200),
  workspaceName: z.string().trim().min(2).max(200),
  currency: z.literal("BRL"),
  timeZone: z.string().trim().min(1).max(64),
  initialBalanceMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, "saldo deve ser um inteiro não negativo")
    .default("0"),
  includeInitialBalance: z.boolean().default(false),
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const invitationRoleSchema = z.enum(["member", "viewer"]);
export const createInvitationSchema = z.object({
  email: z.string().trim().email().max(320),
  role: invitationRoleSchema,
});
export const invitationSchema = z.object({
  id: workspaceIdSchema,
  workspaceId: workspaceIdSchema,
  email: z.string().email(),
  role: invitationRoleSchema,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expiresAt: z.string().datetime({ offset: true }),
  inviteUrl: z.string().url().optional(),
});
export type InvitationContract = z.infer<typeof invitationSchema>;

export const membershipStatusSchema = z.enum(["active", "revoked", "recovery_only"]);
export const workspaceMemberSchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(200),
  email: z.string().email(),
  role: workspaceRoleSchema,
  status: membershipStatusSchema,
  version: z.number().int().nonnegative(),
});
export const workspaceMembersSchema = z.object({
  members: z.array(workspaceMemberSchema),
});
export type WorkspaceMemberContract = z.infer<typeof workspaceMemberSchema>;

/** Invitation listings never include the bearer token or invite URL. */
export const workspaceInvitationListItemSchema = invitationSchema.omit({ inviteUrl: true });
export const workspaceInvitationsSchema = z.object({
  invitations: z.array(workspaceInvitationListItemSchema),
});
export type WorkspaceInvitationListItemContract = z.infer<typeof workspaceInvitationListItemSchema>;

export const updateMembershipRoleSchema = z.object({ role: invitationRoleSchema });
export const deactivateWorkspaceSchema = z.object({
  workspaceName: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(1).max(500),
});

/** Correlation IDs are uppercase ULIDs at the trusted HTTP boundary. */
export const correlationIdSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "correlation ID must be an uppercase ULID");

export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const stockUnitSchema = z.enum(["unit", "package", "box", "kg", "g", "L", "ml", "other"]);
export type StockUnit = z.infer<typeof stockUnitSchema>;
export const stockStateSchema = z.enum(["unknown", "ok", "low", "missing"]);
export type StockState = z.infer<typeof stockStateSchema>;
export const stockMovementKindSchema = z.enum(["entry", "consume", "correction", "discard"]);
export type StockMovementKind = z.infer<typeof stockMovementKindSchema>;

/** Fixed-point quantities travel as canonical decimal strings, never JavaScript floats. */
export const stockQuantitySchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/, "quantidade deve ter até três casas decimais")
  .refine((value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0") || "0") <= 999999999999999n;
  }, "quantidade fora do limite suportado");

export const stockProductSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().trim().min(1).max(200),
  unit: stockUnitSchema,
  unitLabel: z.string().trim().max(40).nullable(),
  quantity: stockQuantitySchema.nullable(),
  minimum: stockQuantitySchema.nullable(),
  markedMissing: z.boolean(),
  /** Controls whether missing/low state is materialized in the shared shopping list. */
  shoppingAuto: z.boolean(),
  state: stockStateSchema,
  category: z.string().trim().max(100).nullable(),
  location: z.string().trim().max(100).nullable(),
  note: z.string().trim().max(500).nullable(),
  archived: z.boolean(),
  version: versionSchema,
});
export type StockProductContract = z.infer<typeof stockProductSchema>;

export const createStockProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    unit: stockUnitSchema.default("unit"),
    unitLabel: z.string().trim().max(40).nullable().optional(),
    quantity: stockQuantitySchema.nullable().optional(),
    minimum: stockQuantitySchema.nullable().optional(),
    shoppingAuto: z.boolean().default(true),
    category: z.string().trim().max(100).nullable().optional(),
    location: z.string().trim().max(100).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.unit === "other" && !value.unitLabel) {
      context.addIssue({
        code: "custom",
        path: ["unitLabel"],
        message: "Informe o rótulo da unidade.",
      });
    }
  });
export type CreateStockProductInput = z.infer<typeof createStockProductSchema>;

export const updateStockProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    unit: stockUnitSchema.optional(),
    unitLabel: z.string().trim().max(40).nullable().optional(),
    minimum: stockQuantitySchema.nullable().optional(),
    shoppingAuto: z.boolean().optional(),
    category: z.string().trim().max(100).nullable().optional(),
    location: z.string().trim().max(100).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.unit === "other" && !value.unitLabel) {
      context.addIssue({
        code: "custom",
        path: ["unitLabel"],
        message: "Informe o rótulo da unidade.",
      });
    }
  });
export type UpdateStockProductInput = z.infer<typeof updateStockProductSchema>;

export const stockBulkModeSchema = z.enum(["valid_only", "all_or_nothing"]);
export type StockBulkMode = z.infer<typeof stockBulkModeSchema>;

const stockBulkContentSchema = z
  .string()
  .min(1, "Informe pelo menos uma linha de produto.")
  .max(10_000_000, "O conteúdo do lote excede o limite permitido.");

export const stockBulkPreviewRequestSchema = z.object({
  content: stockBulkContentSchema,
});
export type StockBulkPreviewRequest = z.infer<typeof stockBulkPreviewRequestSchema>;

export const stockBulkApplyRequestSchema = z.object({
  content: stockBulkContentSchema,
  mode: stockBulkModeSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/, "Hash da prévia inválido."),
});
export type StockBulkApplyRequest = z.infer<typeof stockBulkApplyRequestSchema>;

export const stockProductListQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(100).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const stockMovementSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  productId: domainIdSchema,
  kind: stockMovementKindSchema,
  quantity: stockQuantitySchema,
  before: stockQuantitySchema.nullable(),
  after: stockQuantitySchema.nullable(),
  reason: z.string().trim().max(300).nullable(),
  authorId: userIdSchema,
  occurredAt: z.string().datetime({ offset: true }),
});
export type StockMovementContract = z.infer<typeof stockMovementSchema>;

export const createStockMovementSchema = z.object({
  kind: stockMovementKindSchema,
  /** correction accepts zero; all other operations require a positive quantity. */
  quantity: stockQuantitySchema,
  reason: z.string().trim().max(300).nullable().optional(),
});
export type CreateStockMovementInput = z.infer<typeof createStockMovementSchema>;

export const markStockMissingSchema = z.object({ missing: z.boolean() });

export const stockShoppingItemSourceSchema = z.enum(["automatic", "free"]);
export type StockShoppingItemSource = z.infer<typeof stockShoppingItemSourceSchema>;

export const stockShoppingItemSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  productId: domainIdSchema.nullable(),
  name: z.string().trim().min(1).max(200),
  source: stockShoppingItemSourceSchema,
  quantity: stockQuantitySchema.nullable(),
  unit: stockUnitSchema,
  unitLabel: z.string().trim().max(40).nullable(),
  note: z.string().trim().max(500).nullable(),
  purchased: z.boolean(),
  purchasedAt: z.string().datetime({ offset: true }).nullable(),
  lastChangedBy: userIdSchema.nullable(),
  version: versionSchema,
});
export type StockShoppingItemContract = z.infer<typeof stockShoppingItemSchema>;

export const createStockShoppingItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: stockQuantitySchema.nullable().optional(),
    unit: stockUnitSchema.default("unit"),
    unitLabel: z.string().trim().max(40).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.unit === "other" && !value.unitLabel) {
      context.addIssue({
        code: "custom",
        path: ["unitLabel"],
        message: "Informe o rótulo da unidade.",
      });
    }
  });
export type CreateStockShoppingItemInput = z.infer<typeof createStockShoppingItemSchema>;

export const purchaseStockShoppingItemSchema = z.object({
  /** This explicit flag is the only way a purchase can create a stock entry. */
  addToStock: z.boolean().default(false),
  quantity: stockQuantitySchema.nullable().optional(),
});
export type PurchaseStockShoppingItemInput = z.infer<typeof purchaseStockShoppingItemSchema>;

export const stockShoppingListQuerySchema = paginationQuerySchema.extend({
  includePurchased: z.coerce.boolean().default(false),
});

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

export { civilDateSchema };

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

/** Effective settlement amount/date; omitted amount settles the remaining balance. */
export const settleTransactionSchema = z.object({
  amount: positiveMoneySchema.optional(),
  occurredOn: civilDateSchema.optional(),
});
export type SettleTransactionInput = z.infer<typeof settleTransactionSchema>;

export const loanDirectionSchema = z.enum(["lent", "borrowed"]);
export const loanStatusSchema = z.enum(["open", "settled"]);

export const loanSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  direction: loanDirectionSchema,
  counterparty: z.string().min(1).max(200),
  principal: positiveMoneySchema,
  paid: moneySchema,
  remaining: moneySchema,
  occurredOn: civilDateSchema,
  dueOn: civilDateSchema.nullable(),
  status: loanStatusSchema,
  version: versionSchema,
});

export const createLoanSchema = z
  .object({
    direction: loanDirectionSchema,
    counterparty: z.string().trim().min(1).max(200),
    principal: positiveMoneySchema,
    occurredOn: civilDateSchema.optional(),
    dueOn: civilDateSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.dueOn && value.occurredOn && value.dueOn < value.occurredOn) {
      context.addIssue({
        code: "custom",
        path: ["dueOn"],
        message: "O vencimento não pode ser anterior à data do empréstimo.",
      });
    }
  });

export const loanPaymentSchema = z.object({
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type LoanPaymentInput = z.infer<typeof loanPaymentSchema>;

export const transactionListQuerySchema = paginationQuerySchema
  .extend({
    search: z.string().trim().max(100).optional(),
    from: civilDateSchema.optional(),
    to: civilDateSchema.optional(),
    state: transactionStateSchema.optional(),
    kind: transactionKindSchema.optional(),
    cardId: domainIdSchema.optional(),
  })
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    "from must not be after to",
  );

export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

export const goalStatusSchema = z.enum(["active", "completed", "paused", "canceled"]);
export const goalPrioritySchema = z.enum(["low", "normal", "high"]);
export const goalAmountSchema = z.object({
  amount: positiveMoneySchema,
  allowUncovered: z.boolean().default(false),
});
export const goalAllocateSchema = goalAmountSchema.extend({
  occurredOn: civilDateSchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export const goalReleaseSchema = z.object({
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  target: positiveMoneySchema,
  deadline: civilDateSchema.nullable().optional(),
  priority: goalPrioritySchema.default("normal"),
  note: z.string().trim().max(500).nullable().optional(),
});
export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    target: positiveMoneySchema.optional(),
    deadline: civilDateSchema.nullable().optional(),
    priority: goalPrioritySchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar.");
export const goalSpendSchema = z.object({
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
  description: z.string().trim().max(500).default("Gasto da meta"),
  categoryId: domainIdSchema.nullable().optional(),
});
export const goalTransitionSchema = z.object({ confirm: z.literal(true) });
export const goalSchema = z.object({
  id: domainIdSchema,
  workspaceId: workspaceIdSchema,
  name: z.string().min(1).max(200),
  target: positiveMoneySchema,
  reserved: moneySchema,
  uncovered: moneySchema,
  deadline: civilDateSchema.nullable(),
  priority: goalPrioritySchema,
  status: goalStatusSchema,
  note: z.string().max(500).nullable(),
  version: versionSchema,
});
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type GoalAmountInput = z.infer<typeof goalAmountSchema>;
export type GoalAllocateInput = z.infer<typeof goalAllocateSchema>;
export type GoalReleaseInput = z.infer<typeof goalReleaseSchema>;
export type GoalSpendInput = z.infer<typeof goalSpendSchema>;
export type GoalContract = z.infer<typeof goalSchema>;

/** Audit snapshots are allowlisted server-side and intentionally opaque to clients. */
export const auditSnapshotSchema = z.record(z.string(), z.unknown());
export const financeAuditEventSchema = z.object({
  id: domainIdSchema,
  transactionId: domainIdSchema,
  category: z.string().min(1).max(80),
  action: z.string().min(1).max(120),
  actorId: userIdSchema.nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  origin: z.string().min(1).max(80),
  correlationId: z.string().min(1).max(26),
  result: z.string().min(1).max(80),
  reason: z.string().max(500).nullable(),
  before: auditSnapshotSchema.nullable(),
  after: auditSnapshotSchema.nullable(),
});
export type FinanceAuditEventContract = z.infer<typeof financeAuditEventSchema>;

export const financeAuditLedgerEventSchema = z.object({
  id: domainIdSchema,
  eventType: z.string().min(1).max(120),
  status: z.string().min(1).max(40),
  occurredOn: civilDateSchema,
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  reversedEventId: domainIdSchema.nullable(),
});
export const financeAuditDetailSchema = financeAuditEventSchema.extend({
  consequences: z.object({ ledgerEvents: z.array(financeAuditLedgerEventSchema) }),
});
export type FinanceAuditDetailContract = z.infer<typeof financeAuditDetailSchema>;

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
