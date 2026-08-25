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
  ): Promise<{ replayed: boolean; result: T }>;
  recordAudit?(input: {
    actorId: string;
    targetId: string;
    action: string;
    reason: string;
    correlationId: string;
  }): Promise<void>;
  resolvePlatformActor?(userId: string): Promise<{
    role: PlatformRole | null;
    suspended: boolean;
  }>;
}

export interface AdminAuthPort {
  sendVerificationEmail(email: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
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
    return this.store.searchAccounts({ ...input, query: normalizeAdminAccountSearch(input.query) });
  }

  async getAccount(actor: AdminActor, userId: string): Promise<AdminAccountDetail> {
    assertCanPerformPlatformAction(actor.platformRole, "account:read");
    return this.requireAccount(userId);
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
      { action, targetId, input, correlationId },
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
          });
        }
        return result;
      },
    );
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
