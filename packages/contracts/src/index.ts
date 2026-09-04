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

/** Platform roles are intentionally independent from workspace memberships. */
export const platformRoleSchema = z.enum(["platform_admin", "platform_support"]);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const platformAccountStatusSchema = z.enum(["active", "suspended"]);
export type PlatformAccountStatus = z.infer<typeof platformAccountStatusSchema>;

export const adminAccountSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(320),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type AdminAccountSearchQuery = z.infer<typeof adminAccountSearchQuerySchema>;

const adminInstantSchema = z.string().datetime({ offset: true });

export const adminAccountSummarySchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(200),
  email: z.string().email(),
  role: platformRoleSchema.nullable(),
  status: platformAccountStatusSchema,
  createdAt: adminInstantSchema,
  lastActivityAt: adminInstantSchema.nullable(),
  workspaceCount: z.number().int().nonnegative(),
  activeSessionCount: z.number().int().nonnegative(),
});
export type AdminAccountSummary = z.infer<typeof adminAccountSummarySchema>;

export const adminWorkspaceMetadataSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1).max(200),
  status: z.enum(["active", "deletion_pending", "deactivated"]),
});

export const adminSessionSchema = z.object({
  id: userIdSchema,
  createdAt: adminInstantSchema,
  updatedAt: adminInstantSchema.nullable(),
  expiresAt: adminInstantSchema,
  /** IP is truncated by the server before it crosses the administrative boundary. */
  ipAddress: z.string().max(64).nullable(),
  userAgent: z.string().max(500).nullable(),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

export const adminAccountDetailSchema = adminAccountSummarySchema.extend({
  workspaces: z.array(adminWorkspaceMetadataSchema),
  sessions: z.array(adminSessionSchema),
});
export type AdminAccountDetail = z.infer<typeof adminAccountDetailSchema>;

export const adminAccountListSchema = z.object({
  items: z.array(adminAccountSummarySchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});
export type AdminAccountList = z.infer<typeof adminAccountListSchema>;

export const adminAccountActionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type AdminAccountAction = z.infer<typeof adminAccountActionSchema>;

export const adminPlatformRoleUpdateSchema = z.object({
  role: platformRoleSchema.nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type AdminPlatformRoleUpdate = z.infer<typeof adminPlatformRoleUpdateSchema>;

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

/** Import policies are explicit because a duplicate suggestion is never an implicit skip. */
export const importModeSchema = z.enum(["valid_only", "all_or_nothing"]);
export type ImportMode = z.infer<typeof importModeSchema>;

export const importDuplicatePolicySchema = z.enum(["skip", "import", "review"]);
export type ImportDuplicatePolicy = z.infer<typeof importDuplicatePolicySchema>;

export const importJobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "reversing",
  "reversed",
]);
export type ImportJobState = z.infer<typeof importJobStateSchema>;

export const importDomainSchema = z.enum(["transactions", "products", "full"]);
export type ImportDomain = z.infer<typeof importDomainSchema>;

/** Immutable evidence captured by the preflight and checked again by the worker. */
export const importPreviewManifestLineSchema = z.object({
  lineNumber: z.number().int().min(2).max(50_001),
  status: z.enum(["valid", "duplicate", "invalid"]),
  rowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().trim().min(1).max(512).optional(),
});
export type ImportPreviewManifestLine = z.infer<typeof importPreviewManifestLineSchema>;

export const importPreviewManifestSchema = z
  .array(importPreviewManifestLineSchema)
  .min(1)
  .max(50_000);
export type ImportPreviewManifest = z.infer<typeof importPreviewManifestSchema>;

export const importCreateRequestSchema = z.object({
  domain: importDomainSchema,
  storageKey: z.string().trim().min(1).max(512),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingVersion: z.string().trim().min(1).max(80),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewManifest: importPreviewManifestSchema,
  mode: importModeSchema,
  duplicatePolicy: importDuplicatePolicySchema,
  acceptedDuplicateLines: z.array(z.number().int().min(2).max(50_001)).max(50_000).default([]),
  totalRows: z.number().int().min(1).max(50_000),
  validRows: z.number().int().min(0).max(50_000),
  duplicateRows: z.number().int().min(0).max(50_000),
  invalidRows: z.number().int().min(0).max(50_000),
  expiresAt: z.string().datetime({ offset: true }),
});
export type ImportCreateRequest = z.infer<typeof importCreateRequestSchema>;

export const importLineResultSchema = z.object({
  lineNumber: z.number().int().min(2).max(50_001),
  status: z.enum(["applied", "skipped", "rejected", "reversed"]),
  fingerprint: z.string().trim().min(1).max(512).optional(),
  targetType: z.string().trim().min(1).max(100).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  errorCode: z.string().trim().min(1).max(100).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
});
export type ImportLineResultContract = z.infer<typeof importLineResultSchema>;

export const importLineListQuerySchema = z.object({
  afterLine: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ImportLineListQuery = z.infer<typeof importLineListQuerySchema>;

/** HTTP boundary contracts used by the web data-exchange surface. */
export const dataExchangeDomainSchema = z.enum(["transactions", "products", "complete"]);
export type DataExchangeDomain = z.infer<typeof dataExchangeDomainSchema>;

export const dataExchangeFileFormatSchema = z.enum(["csv", "xlsx"]);
export type DataExchangeFileFormat = z.infer<typeof dataExchangeFileFormatSchema>;

export const dataExchangeLocaleSchema = z.enum(["pt-BR", "en-US"]);
export type DataExchangeLocale = z.infer<typeof dataExchangeLocaleSchema>;

export const exportFormatSchema = z.enum(["csv", "zip"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportKindSchema = z.enum(["all", "income", "expense"]);

export const civilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
    if (year === 0 || month < 1 || month > 12 || day < 1) return false;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= lastDay;
  }, "date must be a real civil date");

export const exportCreateRequestSchema = z.object({
  domain: dataExchangeDomainSchema,
  format: exportFormatSchema,
  from: civilDateSchema.optional(),
  to: civilDateSchema.optional(),
  kind: exportKindSchema.optional(),
  categoryId: z.string().trim().min(1).max(255).nullable().optional(),
});
export type ExportCreateRequest = z.infer<typeof exportCreateRequestSchema>;

export const importPreviewRowSchema = z.object({
  rowNumber: z.number().int().min(2).max(50_001),
  cells: z.array(z.string()).max(256),
  status: z.enum(["valid", "duplicate", "invalid"]),
  errors: z.array(z.string()).max(50),
  warnings: z.array(z.string()).max(50),
});
export type ImportPreviewRowContract = z.infer<typeof importPreviewRowSchema>;

export const importPreviewResponseSchema = z.object({
  id: z.string().trim().min(1).max(255),
  workspaceId: workspaceIdSchema,
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().min(1).max(10_000_000),
  format: dataExchangeFileFormatSchema,
  domain: importDomainSchema.exclude(["full"]),
  headers: z.array(z.string().max(1_000)).max(256),
  rows: z.array(importPreviewRowSchema).max(50_000),
  fields: z.array(
    z.object({
      key: z.string().trim().min(1).max(100),
      label: z.string().trim().min(1).max(255),
      required: z.boolean(),
      aliases: z.array(z.string().max(255)).max(50),
    }),
  ),
  mapping: z.record(z.string().trim().min(1).max(100), z.string().max(1_000)),
  unknownHeaders: z.array(z.string().max(1_000)).max(256),
  locale: dataExchangeLocaleSchema,
  sheetName: z.string().trim().min(1).max(255).optional(),
  sheetIndex: z.number().int().nonnegative().max(255).optional(),
  serverBacked: z.literal(true),
  canConfirm: z.boolean(),
  counts: z.object({
    valid: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  rowLimitExceeded: z.boolean().optional(),
  message: z.string().max(1_000).optional(),
  storageKey: z.string().trim().min(1).max(512),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingVersion: z.string().trim().min(1).max(80),
  previewManifest: importPreviewManifestSchema,
  expiresAt: z.string().datetime({ offset: true }),
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const importJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "partial",
  "failed",
  "canceled",
]);
export type ImportJobStatusContract = z.infer<typeof importJobStatusSchema>;

export const importJobResponseSchema = z.object({
  id: z.string().trim().min(1).max(255),
  workspaceId: workspaceIdSchema,
  status: importJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  totalRows: z.number().int().nonnegative(),
  appliedRows: z.number().int().nonnegative(),
  ignoredRows: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  retryable: z.boolean(),
  errors: z.array(
    z.object({ rowNumber: z.number().int().min(0), message: z.string().min(1).max(500) }),
  ),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(1_000).optional(),
});
export type ImportJobResponse = z.infer<typeof importJobResponseSchema>;

export const exportJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "expired",
]);
export type ExportJobStatusContract = z.infer<typeof exportJobStatusSchema>;

export const exportJobResponseSchema = z.object({
  id: z.string().trim().min(1).max(255),
  workspaceId: workspaceIdSchema,
  domain: dataExchangeDomainSchema,
  format: exportFormatSchema,
  status: exportJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  fileName: z.string().trim().min(1).max(255).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(1_000).optional(),
});
export type ExportJobResponse = z.infer<typeof exportJobResponseSchema>;

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
  /** Optional explicit link to the expense that paid for this completed purchase. */
  expenseTransactionId: domainIdSchema.nullable(),
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
  /** Linking an existing expense is explicit; omitting it never creates one. */
  expenseTransactionId: domainIdSchema.nullable().optional(),
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
  "step_up_required",
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

export const insightWindowQuerySchema = z
  .object({
    asOf: civilDateSchema.optional(),
    from: civilDateSchema.optional(),
    to: civilDateSchema.optional(),
  })
  .refine((query) => {
    const effectiveFrom = query.from ?? query.asOf;
    const effectiveTo = query.to ?? query.asOf;
    return !effectiveFrom || !effectiveTo || effectiveFrom <= effectiveTo;
  }, "from must not be after to");
export type InsightWindowQuery = z.infer<typeof insightWindowQuerySchema>;

export const safeToSpendQuerySchema = z.object({
  asOf: civilDateSchema.optional(),
  horizonDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type SafeToSpendQuery = z.infer<typeof safeToSpendQuerySchema>;

export const insightReportKindSchema = z.enum(["all", "income", "expense"]);
export const insightReportQuerySchema = z
  .object({
    asOf: civilDateSchema.optional(),
    from: civilDateSchema.optional(),
    to: civilDateSchema.optional(),
    kind: insightReportKindSchema.default("all"),
    categoryId: domainIdSchema.optional(),
  })
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    "from must not be after to",
  );
export type InsightReportQuery = z.infer<typeof insightReportQuerySchema>;

const minorAmountSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/, "minor must be a canonical decimal integer")
  .refine((value) => {
    try {
      const minor = BigInt(value);
      return minor >= -999999999999999n && minor <= 999999999999999n;
    } catch {
      return false;
    }
  }, "minor is outside the supported range");

export const moneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  minor: minorAmountSchema,
});

export type MoneyContract = z.infer<typeof moneySchema>;

const insightReportPeriodSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  income: moneySchema,
  expense: moneySchema,
  net: moneySchema,
  transactionCount: z.number().int().nonnegative(),
});

const insightReportCategorySchema = z.object({
  categoryId: domainIdSchema.nullable(),
  categoryName: z.string().min(1).max(80),
  income: moneySchema,
  expense: moneySchema,
  net: moneySchema,
  transactionCount: z.number().int().nonnegative(),
});

export const insightReportSchema = z.object({
  asOf: civilDateSchema,
  from: civilDateSchema,
  to: civilDateSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  filters: z.object({
    kind: insightReportKindSchema,
    categoryId: domainIdSchema.nullable(),
  }),
  totals: z.object({
    income: moneySchema,
    expense: moneySchema,
    net: moneySchema,
    transactionCount: z.number().int().nonnegative(),
  }),
  monthly: z.array(insightReportPeriodSchema),
  categories: z.array(insightReportCategorySchema),
  reconciliation: z.object({
    source: z.literal("published_ledger"),
    transactionCount: z.number().int().nonnegative(),
    income: moneySchema,
    expense: moneySchema,
    export: z.object({
      domain: z.literal("transactions"),
      format: z.literal("csv"),
      from: civilDateSchema,
      to: civilDateSchema,
      kind: insightReportKindSchema,
      categoryId: domainIdSchema.nullable(),
    }),
  }),
});
export type InsightReportContract = z.infer<typeof insightReportSchema>;

export const positiveMoneySchema = moneySchema.extend({
  minor: minorAmountSchema.refine((value) => BigInt(value) > 0n, "minor must be greater than zero"),
});

const nonNegativeMoneySchema = moneySchema.extend({
  minor: minorAmountSchema.refine(
    (value) => BigInt(value) >= 0n,
    "minor must be greater than or equal to zero",
  ),
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

export const walletSchema = z.object({
  workspaceId: workspaceIdSchema,
  balance: moneySchema,
  version: versionSchema,
});
export type WalletContract = z.infer<typeof walletSchema>;

export const walletAdjustmentPreviewInputSchema = z.object({
  observedBalance: moneySchema,
});
export type WalletAdjustmentPreviewInput = z.infer<typeof walletAdjustmentPreviewInputSchema>;

export const walletAdjustmentInputSchema = walletAdjustmentPreviewInputSchema.extend({
  reason: z.string().trim().min(1, "Informe o motivo do ajuste.").max(500),
});
export type WalletAdjustmentInput = z.infer<typeof walletAdjustmentInputSchema>;

export const walletAdjustmentPreviewSchema = z.object({
  wallet: walletSchema,
  observedBalance: moneySchema,
  difference: moneySchema,
});
export type WalletAdjustmentPreviewContract = z.infer<typeof walletAdjustmentPreviewSchema>;

export const walletAdjustmentResultSchema = walletAdjustmentPreviewSchema.extend({
  transaction: transactionSchema,
});
export type WalletAdjustmentResultContract = z.infer<typeof walletAdjustmentResultSchema>;

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

/** Fields that can be corrected before a transaction has published ledger events. */
export const updateTransactionSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    occurredOn: civilDateSchema.optional(),
    dueOn: civilDateSchema.nullable().optional(),
    description: z.string().trim().max(500).optional(),
    categoryId: domainIdSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar.");

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

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

export const loanPaymentViewSchema = z.object({
  id: domainIdSchema,
  loanId: domainIdSchema,
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema,
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type LoanPaymentInput = z.infer<typeof loanPaymentSchema>;
export type LoanPaymentView = z.infer<typeof loanPaymentViewSchema>;

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
  remaining: moneySchema,
  contributionPeriodsRemaining: z.number().int().nonnegative().nullable(),
  requiredContribution: moneySchema.nullable(),
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
export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: categoryKindSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar.");
export const categoryTransitionSchema = z.object({ confirm: z.literal(true) });

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
  limit: nonNegativeMoneySchema.nullable(),
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
  limit: nonNegativeMoneySchema.nullable().optional(),
});

export const updateCreditCardSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    closingDay: z.number().int().min(1).max(31).optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    holder: z.string().trim().max(100).nullable().optional(),
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    limit: nonNegativeMoneySchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Informe ao menos uma configuração para alterar.",
  });
export type UpdateCreditCardInput = z.infer<typeof updateCreditCardSchema>;

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
  type: z.enum(["purchase", "payment", "adjustment", "refund"]),
  state: z.enum(["planned", "partially_settled", "posted", "canceled"]),
  description: z.string(),
  occurredOn: civilDateSchema,
  amount: moneySchema,
});

export const statementAdjustmentKindSchema = z.enum(["charge", "fee", "interest"]);
export const createStatementAdjustmentSchema = z.object({
  kind: statementAdjustmentKindSchema,
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
  description: z.string().trim().min(1).max(500),
});
export type CreateStatementAdjustmentInput = z.infer<typeof createStatementAdjustmentSchema>;

export const createStatementRefundSchema = z.object({
  sourceTransactionId: domainIdSchema,
  amount: positiveMoneySchema,
  occurredOn: civilDateSchema.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateStatementRefundInput = z.infer<typeof createStatementRefundSchema>;

export const payStatementSchema = z.object({
  amount: positiveMoneySchema.optional(),
  occurredOn: civilDateSchema.optional(),
  allowCredit: z.boolean().default(false),
});

export const createRecurrenceSchema = z
  .object({
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
  })
  .superRefine((value, context) => {
    if (value.endOn && value.endOn < value.startOn) {
      context.addIssue({
        code: "custom",
        path: ["endOn"],
        message: "O fim da recorrência deve ser posterior ao início.",
      });
    }
    if (!value.variable && value.estimatedAmount) {
      context.addIssue({
        code: "custom",
        path: ["estimatedAmount"],
        message: "A estimativa só se aplica a recorrência variável.",
      });
    }
  });

export const recurrenceTransitionSchema = z.object({
  /** Pause takes effect on this civil date; omitted means today in the workspace. */
  effectiveOn: civilDateSchema.optional(),
});
export type RecurrenceTransitionInput = z.infer<typeof recurrenceTransitionSchema>;

export const recurrenceEditScopeSchema = z.enum(["this", "this_and_future", "future_unsettled"]);
export type RecurrenceEditScope = z.infer<typeof recurrenceEditScopeSchema>;

/**
 * Edits are anchored to an already materialized occurrence. The server keeps
 * posted/partially settled occurrences immutable and records one-off edits as
 * exceptions so a later series edit cannot silently overwrite them.
 */
export const updateRecurrenceSchema = z
  .object({
    scope: recurrenceEditScopeSchema,
    effectiveOn: civilDateSchema,
    amount: positiveMoneySchema.optional(),
    description: z.string().trim().max(500).optional(),
    endOn: civilDateSchema.nullable().optional(),
    estimatedAmount: positiveMoneySchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.amount !== undefined ||
      value.description !== undefined ||
      value.endOn !== undefined ||
      value.estimatedAmount !== undefined,
    "Informe ao menos um campo para editar.",
  )
  .superRefine((value, context) => {
    if (
      value.scope === "this" &&
      (value.endOn !== undefined || value.estimatedAmount !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Uma exceção pode alterar somente valor e descrição da ocorrência.",
      });
    }
  });
export type UpdateRecurrenceInput = z.infer<typeof updateRecurrenceSchema>;

export const createInstallmentPlanSchema = z.object({
  total: positiveMoneySchema,
  count: z.number().int().min(2).max(999),
  firstDueOn: civilDateSchema,
  description: z.string().trim().max(500).default(""),
});
export type CreateInstallmentPlanInput = z.infer<typeof createInstallmentPlanSchema>;

export const installmentPreviewSchema = createInstallmentPlanSchema;
export type InstallmentPreviewInput = z.infer<typeof installmentPreviewSchema>;

export const installmentPlanUpdateSchema = z
  .object({
    total: positiveMoneySchema.optional(),
    count: z.number().int().min(2).max(999).optional(),
    firstDueOn: civilDateSchema.optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar.");
export type InstallmentPlanUpdateInput = z.infer<typeof installmentPlanUpdateSchema>;

export const installmentUpdateSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    dueOn: civilDateSchema.optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para editar.");
export type InstallmentUpdateInput = z.infer<typeof installmentUpdateSchema>;

export const installmentCancelSchema = z.object({ confirm: z.literal(true) });
