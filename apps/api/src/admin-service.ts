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
  assertPlatformTwoFactor,
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
  sendVerificationEmail(email: string, idempotencyKey?: string): Promise<void>;
  sendPasswordReset(email: string, idempotencyKey?: string): Promise<void>;
  verifyStepUp?(input: {
    method: "totp" | "backup_code";
    code: string;
    headers: Headers;
  }): Promise<void>;
  startTwoFactorEnrollment?(input: {
    password: string;
    headers: Headers;
  }): Promise<{ totpURI: string; backupCodes: string[] }>;
  verifyTwoFactorEnrollment?(input: { code: string; headers: Headers }): Promise<void>;
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    return this.withActor(actor, () =>
      this.store.searchAccounts({ ...input, query: normalizeAdminAccountSearch(input.query) }),
    );
  }

  async getAccount(actor: AdminActor, userId: string): Promise<AdminAccountDetail> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    return this.withActor(actor, () => this.requireAccount(userId));
  }

  getPlatformSession(actor: AdminActor): {
    userId: string;
    displayName: string;
    role: PlatformRole;
    twoFactorEnabled: boolean;
  } {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (!actor.platformRole) throw new AdminPolicyError("permission_denied");
    return {
      userId: actor.userId,
      displayName: actor.displayName ?? "",
      role: actor.platformRole,
      twoFactorEnabled: actor.twoFactorEnabled === true,
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.executeEmailCommand(
      actor,
      idempotencyKey,
      correlationId,
      "auth:verification-resend",
      userId,
      input,
      (email) => this.auth.sendVerificationEmail(email, idempotencyKey),
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
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    return this.executeEmailCommand(
      actor,
      idempotencyKey,
      correlationId,
      "auth:recovery-resend",
      userId,
      input,
      (email) => this.auth.sendPasswordReset(email, idempotencyKey),
    );
  }

  async completeStepUp(
    actor: AdminActor,
    input: { method: "totp" | "backup_code"; code: string },
    headers: Headers,
    correlationId: string,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
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

  async startTwoFactorEnrollment(
    actor: AdminActor,
    password: string,
    headers: Headers,
  ): Promise<{ totpURI: string; backupCodes: string[] }> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (actor.twoFactorEnabled === true || !this.auth.startTwoFactorEnrollment) {
      throw new AdminPolicyError("permission_denied");
    }
    return this.auth.startTwoFactorEnrollment({ password, headers });
  }

  async verifyTwoFactorEnrollment(
    actor: AdminActor,
    code: string,
    headers: Headers,
  ): Promise<void> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (actor.twoFactorEnabled === true || !this.auth.verifyTwoFactorEnrollment) {
      throw new AdminPolicyError("permission_denied");
    }
    await this.auth.verifyTwoFactorEnrollment({ code, headers });
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

  /**
   * Email delivery is deliberately invoked after the idempotency transaction
   * commits. The command key is forwarded to Better Auth so its durable
   * auth-email outbox derives the same sourceId on a retry.
   */
  private async executeEmailCommand(
    actor: AdminActor,
    idempotencyKey: string,
    correlationId: string,
    action: string,
    userId: string,
    input: unknown,
    send: (email: string) => Promise<void>,
  ): Promise<CommandResult<null>> {
    const result = await this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      action,
      userId,
      input,
      async () => {
        await this.requireAccount(userId);
        return null;
      },
    );
    const account = await this.withActor(actor, () => this.requireAccount(userId));
    await send(account.email);
    return result;
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
