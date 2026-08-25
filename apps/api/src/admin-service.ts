import type {
  AdminAccountAction,
  AdminAccountDetail,
  AdminAccountList,
  AdminAccountSearchQuery,
  AdminPlatformRoleUpdate,
  PlatformRole,
} from "@casei/contracts";
import {
  AdminPolicyError,
  assertCanPerformPlatformAction,
  assertLastPlatformAdminCanChange,
  assertRecentPlatformAuthentication,
  normalizeAdminAccountSearch,
} from "./admin-policy.js";
import type { RequestActor } from "./http/types.js";

export class AdminNotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor() {
    super("Account not found");
    this.name = "AdminNotFoundError";
  }
}

export interface AdminActor extends RequestActor {
  platformRole?: PlatformRole | null;
}

export interface AdminAccountStore {
  searchAccounts(input: AdminAccountSearchQuery): Promise<AdminAccountList>;
  getAccount(userId: string): Promise<AdminAccountDetail | null>;
  countActivePlatformAdmins(): Promise<number>;
  updateStatus(
    userId: string,
    status: "active" | "suspended",
    reason?: string,
  ): Promise<AdminAccountDetail>;
  updateRole(
    userId: string,
    role: PlatformRole | null,
    reason?: string,
  ): Promise<AdminAccountDetail>;
  revokeSession(userId: string, sessionId: string): Promise<void>;
  executeIdempotent<T>(
    scope: string,
    key: string,
    request: unknown,
    run: () => Promise<T>,
    actorId?: string,
    stepUpToken?: string,
  ): Promise<{ replayed: boolean; result: T }>;
  /** Establishes the database actor context before any platform query. */
  withActor?<T>(actorId: string, run: () => Promise<T>): Promise<T>;
  recordAudit?(input: {
    actorId: string;
    targetId: string;
    action: string;
    reason: string;
    correlationId: string;
    ipAddress?: string | null;
    endpoint?: string | null;
  }): Promise<void>;
  issueStepUpChallenge?(input: {
    userId: string;
    method: "totp" | "backup_code";
    correlationId: string;
  }): Promise<string>;
  resolvePlatformActor?(userId: string): Promise<{
    role: PlatformRole | null;
    suspended: boolean;
  }>;
}

export interface AdminAuthPort {
  sendVerificationEmail(email: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  verifyStepUp?(input: {
    method: "totp" | "backup_code";
    code: string;
    headers: Headers;
  }): Promise<void>;
}

type CommandResult<T> = { replayed: boolean; result: T };

export class AdminService {
  constructor(
    private readonly store: AdminAccountStore,
    private readonly auth: AdminAuthPort,
  ) {}

  async searchAccounts(
    actor: AdminActor,
    input: AdminAccountSearchQuery,
  ): Promise<AdminAccountList> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    return this.withActor(actor, () =>
      this.store.searchAccounts({ ...input, query: normalizeAdminAccountSearch(input.query) }),
    );
  }

  async getAccount(actor: AdminActor, userId: string): Promise<AdminAccountDetail> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    return this.withActor(actor, () => this.requireAccount(userId));
  }

  getPlatformSession(actor: AdminActor): {
    userId: string;
    displayName: string;
    role: PlatformRole;
  } {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (!actor.platformRole) throw new AdminPolicyError("permission_denied");
    return {
      userId: actor.userId,
      displayName: actor.displayName ?? "",
      role: actor.platformRole,
    };
  }

  async suspendAccount(
    actor: AdminActor,
    userId: string,
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<AdminAccountDetail>> {
    assertCanPerformPlatformAction(actor.platformRole, "account:suspend");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.accountStatusCommand(
      actor,
      userId,
      "suspended",
      input,
      idempotencyKey,
      correlationId,
    );
  }

  async reactivateAccount(
    actor: AdminActor,
    userId: string,
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<AdminAccountDetail>> {
    assertCanPerformPlatformAction(actor.platformRole, "account:reactivate");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.accountStatusCommand(actor, userId, "active", input, idempotencyKey, correlationId);
  }

  async changePlatformRole(
    actor: AdminActor,
    userId: string,
    input: AdminPlatformRoleUpdate,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<AdminAccountDetail>> {
    assertCanPerformPlatformAction(actor.platformRole, "platform-role:change");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    this.assertNotSelf(actor, userId);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      "platform-role:change",
      userId,
      input,
      async () => {
        const target = await this.requireAccount(userId);
        const activeAdminCount = await this.store.countActivePlatformAdmins();
        assertLastPlatformAdminCanChange({
          activeAdminCount,
          targetIsAdmin: target.role === "platform_admin" && target.status === "active",
          nextRole: input.role,
        });
        return this.store.updateRole(userId, input.role, input.reason);
      },
    );
  }

  async revokeSession(
    actor: AdminActor,
    userId: string,
    sessionId: string,
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<null>> {
    assertCanPerformPlatformAction(actor.platformRole, "session:revoke");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      "session:revoke",
      `${userId}:${sessionId}`,
      input,
      async () => {
        await this.requireAccount(userId);
        await this.store.revokeSession(userId, sessionId);
        return null;
      },
    );
  }

  async resendVerification(
    actor: AdminActor,
    userId: string,
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<null>> {
    assertCanPerformPlatformAction(actor.platformRole, "auth:resend");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      "auth:verification-resend",
      userId,
      input,
      async () => {
        const target = await this.requireAccount(userId);
        await this.auth.sendVerificationEmail(target.email);
        return null;
      },
    );
  }

  async resendRecovery(
    actor: AdminActor,
    userId: string,
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<null>> {
    assertCanPerformPlatformAction(actor.platformRole, "auth:resend");
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      "auth:recovery-resend",
      userId,
      input,
      async () => {
        const target = await this.requireAccount(userId);
        await this.auth.sendPasswordReset(target.email);
        return null;
      },
    );
  }

  async completeStepUp(
    actor: AdminActor,
    input: { method: "totp" | "backup_code"; code: string },
    headers: Headers,
    correlationId: string,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (!this.auth.verifyStepUp || !this.store.issueStepUpChallenge) {
      throw new AdminPolicyError("step_up_required");
    }
    await this.auth.verifyStepUp({ ...input, headers });
    const token = await this.store.issueStepUpChallenge({
      userId: actor.userId,
      method: input.method,
      correlationId,
    });
    return { token, expiresInSeconds: 300 };
  }

  private async accountStatusCommand(
    actor: AdminActor,
    userId: string,
    status: "active" | "suspended",
    input: AdminAccountAction,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<AdminAccountDetail>> {
    this.assertNotSelf(actor, userId);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      `account:${status}`,
      userId,
      input,
      async () => {
        const target = await this.requireAccount(userId);
        if (status === "suspended") {
          const activeAdminCount = await this.store.countActivePlatformAdmins();
          assertLastPlatformAdminCanChange({
            activeAdminCount,
            targetIsAdmin: target.role === "platform_admin" && target.status === "active",
            nextRole: target.role,
          });
        }
        return this.store.updateStatus(userId, status, input.reason);
      },
    );
  }

  private async executeCommand<T>(
    actor: AdminActor,
    idempotencyKey: string,
    correlationId: string,
    action: string,
    targetId: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<CommandResult<T>> {
    return this.store.executeIdempotent(
      `${actor.userId}:platform:${action}:${targetId}`,
      idempotencyKey,
      // Correlation IDs identify attempts for audit/tracing; they must not
      // change the idempotency fingerprint of the same client command.
      { action, targetId, input },
      async () => {
        const result = await run();
        if (this.store.recordAudit) {
          const reason =
            typeof input === "object" && input !== null && "reason" in input
              ? String((input as { reason?: unknown }).reason ?? "")
              : "";
          await this.store.recordAudit({
            actorId: actor.userId,
            targetId,
            action,
            reason,
            correlationId,
            ipAddress: actor.ipAddress,
            endpoint: actor.endpoint,
          });
        }
        return result;
      },
      actor.userId,
      actor.stepUpToken,
    );
  }

  private withActor<T>(actor: AdminActor, run: () => Promise<T>): Promise<T> {
    return this.store.withActor?.(actor.userId, run) ?? run();
  }

  private async requireAccount(userId: string): Promise<AdminAccountDetail> {
    const account = await this.store.getAccount(userId);
    if (!account) throw new AdminNotFoundError();
    return account;
  }

  private assertNotSelf(actor: AdminActor, targetUserId: string): void {
    if (actor.userId === targetUserId) throw new AdminPolicyError("permission_denied");
  }
}
