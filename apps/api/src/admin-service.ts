import { createHash } from "node:crypto";
import type {
  AdminAccountAction,
  AdminAccountDetail,
  AdminAccountList,
  AdminAccountSearchQuery,
  AdminAuditList,
  AdminAuditSearchQuery,
  AdminJobList,
  AdminJobRetryInput,
  AdminJobSearchQuery,
  AdminJobSummary,
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

export type AdminEmailDeliveryAudit = {
  actorId: string;
  targetId: string;
  action: string;
  reason: string;
  correlationId: string;
  ipAddress?: string | null;
  endpoint?: string | null;
};

export type AdminEmailCommand<T> = {
  email: string;
  result: T;
};

export type AdminAuditResult = "success" | "failure";

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
  /** Finalizes idempotency and audit only after the auth email is accepted. */
  executeEmailIdempotent?<T>(
    scope: string,
    key: string,
    request: unknown,
    run: () => Promise<AdminEmailCommand<T>>,
    send: (email: string) => Promise<void>,
    audit: AdminEmailDeliveryAudit,
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
    result?: AdminAuditResult;
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
  searchJobs?(input: AdminJobSearchQuery): Promise<AdminJobList>;
  retryJob?(jobId: string): Promise<AdminJobSummary>;
  searchAudit?(input: AdminAuditSearchQuery): Promise<AdminAuditList>;
}

export interface AdminAuthPort {
  sendVerificationEmail(
    email: string,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<void>;
  sendPasswordReset(email: string, idempotencyKey?: string, correlationId?: string): Promise<void>;
  verifyStepUp?(input: {
    method: "totp" | "backup_code";
    code: string;
    headers: Headers;
  }): Promise<void>;
  startTwoFactorEnrollment?(input: {
    password: string;
    headers: Headers;
  }): Promise<{ totpURI: string; backupCodes: string[] }>;
  verifyTwoFactorEnrollment?(input: {
    code: string;
    headers: Headers;
  }): Promise<{ setCookies: string[] }>;
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

  async searchJobs(actor: AdminActor, input: AdminJobSearchQuery): Promise<AdminJobList> {
    assertCanPerformPlatformAction(actor.platformRole, "job:read");
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    if (!this.store.searchJobs) throw new Error("Job administration is unavailable");
    const searchJobs = this.store.searchJobs.bind(this.store);
    return this.withActor(actor, () => searchJobs(input));
  }

  async searchAudit(actor: AdminActor, input: AdminAuditSearchQuery): Promise<AdminAuditList> {
    assertCanPerformPlatformAction(actor.platformRole, "job:read");
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    if (!this.store.searchAudit) throw new Error("Audit administration is unavailable");
    const searchAudit = this.store.searchAudit.bind(this.store);
    return this.withActor(actor, () => searchAudit(input));
  }

  async retryJob(
    actor: AdminActor,
    jobId: string,
    input: AdminJobRetryInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<CommandResult<AdminJobSummary>> {
    assertCanPerformPlatformAction(actor.platformRole, "job:retry");
    assertPlatformTwoFactor(actor.platformRole, actor.twoFactorEnabled);
    assertRecentPlatformAuthentication(actor.recentAuthentication);
    if (!this.store.retryJob) throw new Error("Job administration is unavailable");
    const retryJob = this.store.retryJob.bind(this.store);
    return this.executeCommand(
      actor,
      idempotencyKey,
      correlationId,
      "job:retry",
      jobId,
      input,
      () => retryJob(jobId),
    );
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
      (email) =>
        this.auth.sendVerificationEmail(
          email,
          deriveEmailDispatchKey(actor.userId, "auth:verification-resend", userId, idempotencyKey),
          correlationId,
        ),
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
      (email) =>
        this.auth.sendPasswordReset(
          email,
          deriveEmailDispatchKey(actor.userId, "auth:recovery-resend", userId, idempotencyKey),
          correlationId,
        ),
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
  ): Promise<string[]> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    if (actor.twoFactorEnabled === true || !this.auth.verifyTwoFactorEnrollment) {
      throw new AdminPolicyError("permission_denied");
    }
    const result = await this.auth.verifyTwoFactorEnrollment({ code, headers });
    return result.setCookies;
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
    try {
      return await this.store.executeIdempotent(
        `${actor.userId}:platform:${action}:${targetId}`,
        idempotencyKey,
        // Correlation IDs identify attempts for audit/tracing; they must not
        // change the idempotency fingerprint of the same client command.
        { action, targetId, input },
        async () => {
          const result = await run();
          await this.recordCommandAudit({
            actor,
            targetId,
            action,
            reason: commandReason(input),
            correlationId,
            result: "success",
          });
          return result;
        },
        actor.userId,
        actor.stepUpToken,
      );
    } catch (error) {
      // The command transaction is rolled back before this catch runs. Keep
      // the failure audit in its own transaction so rejected commands remain
      // visible without making the original error unsafe or opaque.
      await this.recordCommandAudit({
        actor,
        targetId,
        action,
        reason: `${commandReason(input)} [failure:${adminErrorCode(error)}]`,
        correlationId,
        result: "failure",
      }).catch(() => undefined);
      throw error;
    }
  }

  private recordCommandAudit(input: {
    actor: AdminActor;
    targetId: string;
    action: string;
    reason: string;
    correlationId: string;
    result: AdminAuditResult;
  }): Promise<void> {
    const recordAudit = this.store.recordAudit;
    if (!recordAudit) return Promise.resolve();
    return this.withActor(input.actor, () =>
      recordAudit.call(this.store, {
        actorId: input.actor.userId,
        targetId: input.targetId,
        action: input.action,
        reason: input.reason,
        correlationId: input.correlationId,
        ipAddress: input.actor.ipAddress,
        endpoint: input.actor.endpoint,
        result: input.result,
      }),
    );
  }

  /**
   * Email delivery is invoked after a durable pending intent commits. The
   * store finalizes idempotency and audit only after Better Auth accepts it;
   * retries keep the same scoped auth-email key.
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
    const scope = `${actor.userId}:platform:${action}:${userId}`;
    const request = { action, targetId: userId, input };
    if (this.store.executeEmailIdempotent) {
      try {
        return await this.store.executeEmailIdempotent(
          scope,
          idempotencyKey,
          request,
          async () => {
            const account = await this.requireAccount(userId);
            return { email: account.email, result: null };
          },
          send,
          {
            actorId: actor.userId,
            targetId: userId,
            action,
            reason: commandReason(input),
            correlationId,
            ipAddress: actor.ipAddress,
            endpoint: actor.endpoint,
          },
          actor.userId,
          actor.stepUpToken,
        );
      } catch (error) {
        if (error instanceof AdminNotFoundError) {
          await this.recordCommandAudit({
            actor,
            targetId: userId,
            action,
            reason: `${commandReason(input)} [failure:${adminErrorCode(error)}]`,
            correlationId,
            result: "failure",
          }).catch(() => undefined);
        }
        throw error;
      }
    }
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

function deriveEmailDispatchKey(
  actorId: string,
  action: string,
  targetId: string,
  commandKey: string,
): string {
  return `admin-email-${createHash("sha256")
    .update(`${actorId}\0${action}\0${targetId}\0${commandKey}`)
    .digest("hex")}`;
}

function commandReason(input: unknown): string {
  if (typeof input !== "object" || input === null || !("reason" in input)) return "";
  return String((input as { reason?: unknown }).reason ?? "");
}

function adminErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_:-]{1,64}$/.test(code)) return code;
  }
  return "internal_error";
}
