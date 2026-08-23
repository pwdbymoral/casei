import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "member"]);

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
