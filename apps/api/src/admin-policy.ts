import type { PlatformRole } from "@casei/contracts";

export type PlatformAdminAction =
  | "account:read"
  | "account:suspend"
  | "account:reactivate"
  | "session:revoke"
  | "auth:resend"
  | "platform-role:change";

type AdminPolicyCode = "permission_denied" | "recent_auth_required" | "last_platform_admin";

export class AdminPolicyError extends Error {
  readonly code: AdminPolicyCode;

  constructor(code: AdminPolicyCode) {
    super(code);
    this.name = "AdminPolicyError";
    this.code = code;
  }
}

const SUPPORT_ACTIONS = new Set<PlatformAdminAction>([
  "account:read",
  "account:suspend",
  "account:reactivate",
  "session:revoke",
  "auth:resend",
]);

export function assertCanPerformPlatformAction(
  role: PlatformRole | null | undefined,
  action: PlatformAdminAction,
): void {
  if (role === "platform_admin") return;
  if (role === "platform_support" && SUPPORT_ACTIONS.has(action)) return;
  throw new AdminPolicyError("permission_denied");
}

export function assertRecentPlatformAuthentication(
  recentAuthentication: boolean | undefined,
): void {
  if (!recentAuthentication) throw new AdminPolicyError("recent_auth_required");
}

export function assertLastPlatformAdminCanChange(input: {
  activeAdminCount: number;
  targetIsAdmin: boolean;
  nextRole: PlatformRole | null;
}): void {
  if (input.targetIsAdmin && input.nextRole !== "platform_admin" && input.activeAdminCount <= 1) {
    throw new AdminPolicyError("last_platform_admin");
  }
}

/** Exact e-mail matching is case-insensitive; opaque IDs retain their case and spelling. */
export function normalizeAdminAccountSearch(value: string): string {
  const normalized = value.trim();
  return normalized.includes("@") ? normalized.toLowerCase() : normalized;
}
