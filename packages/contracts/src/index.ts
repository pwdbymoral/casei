import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "member"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceMembershipSchema = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: workspaceRoleSchema,
});

export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

/** IDs of Casei domain entities are UUIDs; Better Auth user IDs remain opaque strings. */
export const domainIdSchema = z.string().uuid();
export const workspaceIdSchema = domainIdSchema;
export const userIdSchema = z.string().min(1).max(255);

/** Correlation IDs are uppercase ULIDs at the trusted HTTP boundary. */
export const correlationIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "correlation ID must be an uppercase ULID");

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
