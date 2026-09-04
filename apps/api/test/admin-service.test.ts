import type { AdminAccountDetail, AdminAccountList, PlatformRole } from "@casei/contracts";
import { describe, expect, it } from "vitest";
import {
  type AdminAccountStore,
  type AdminAuthPort,
  type AdminEmailCommand,
  type AdminEmailDeliveryAudit,
  AdminNotFoundError,
  AdminService,
} from "../src/admin-service.js";

const actor = (role: PlatformRole, recentAuthentication = true) => ({
  userId: "admin-user",
  email: "admin@example.com",
  displayName: "Admin",
  platformRole: role,
  recentAuthentication,
  twoFactorEnabled: true,
});

const account: AdminAccountDetail = {
  userId: "target-user",
  displayName: "Pessoa",
  email: "person@example.com",
  role: null,
  status: "active",
  createdAt: "2026-08-25T12:00:00.000Z",
  lastActivityAt: "2026-08-25T12:30:00.000Z",
  workspaceCount: 1,
  activeSessionCount: 1,
  workspaces: [
    {
      id: "0190f3c8-2a10-7abc-8def-1234567890ab",
      name: "Casa",
      status: "active",
    },
  ],
  sessions: [
    {
      id: "session-1",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:30:00.000Z",
      expiresAt: "2026-09-25T12:00:00.000Z",
      ipAddress: "203.0.113.0/24",
      userAgent: "browser",
    },
  ],
};

class MemoryAdminStore implements AdminAccountStore {
  current = structuredClone(account);
  activeAdminCount = 2;
  calls = 0;
  audits: Array<{ action: string; reason: string }> = [];
  auditResults: Array<"success" | "failure"> = [];
  private readonly results = new Map<string, unknown>();

  async searchAccounts(): Promise<AdminAccountList> {
    return { items: [this.current], page: { nextCursor: null, hasMore: false } };
  }

  async getAccount(userId: string): Promise<AdminAccountDetail | null> {
    return userId === this.current.userId ? structuredClone(this.current) : null;
  }

  async countActivePlatformAdmins(): Promise<number> {
    return this.activeAdminCount;
  }

  async updateStatus(userId: string, status: "active" | "suspended"): Promise<AdminAccountDetail> {
    if (userId !== this.current.userId) throw new AdminNotFoundError();
    this.calls += 1;
    this.current.status = status;
    return structuredClone(this.current);
  }

  async updateRole(userId: string, role: PlatformRole | null): Promise<AdminAccountDetail> {
    if (userId !== this.current.userId) throw new AdminNotFoundError();
    this.calls += 1;
    this.current.role = role;
    return structuredClone(this.current);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    if (userId !== this.current.userId || sessionId !== "session-1") throw new AdminNotFoundError();
    this.calls += 1;
  }

  async recordAudit(input: {
    action: string;
    reason: string;
    result?: "success" | "failure";
  }): Promise<void> {
    this.audits.push({ action: input.action, reason: input.reason });
    this.auditResults.push(input.result ?? "success");
  }

  async executeIdempotent<T>(scope: string, key: string, request: unknown, run: () => Promise<T>) {
    const id = `${scope}:${key}`;
    const existing = this.results.get(id);
    if (existing !== undefined) return { replayed: true, result: existing as T };
    const result = await run();
    this.results.set(id, result);
    void request;
    return { replayed: false, result };
  }
}

class MemoryAuthPort implements AdminAuthPort {
  verification = 0;
  recovery = 0;
  verificationKeys: string[] = [];
  recoveryKeys: string[] = [];
  verificationCorrelations: Array<string | undefined> = [];
  recoveryCorrelations: Array<string | undefined> = [];
  async sendVerificationEmail(
    email: string,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<void> {
    if (email !== account.email) throw new AdminNotFoundError();
    this.verification += 1;
    if (idempotencyKey) this.verificationKeys.push(idempotencyKey);
    this.verificationCorrelations.push(correlationId);
  }
  async sendPasswordReset(
    email: string,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<void> {
    if (email !== account.email) throw new AdminNotFoundError();
    this.recovery += 1;
    if (idempotencyKey) this.recoveryKeys.push(idempotencyKey);
    this.recoveryCorrelations.push(correlationId);
  }
}

class PendingEmailStore extends MemoryAdminStore {
  readonly deliveries = new Map<string, { status: "pending" | "sent" | "failed" }>();

  async executeEmailIdempotent<T>(
    scope: string,
    key: string,
    _request: unknown,
    run: () => Promise<AdminEmailCommand<T>>,
    send: (email: string) => Promise<void>,
    audit: AdminEmailDeliveryAudit,
  ): Promise<{ replayed: boolean; result: T }> {
    const deliveryKey = `${scope}:${key}`;
    let delivery = this.deliveries.get(deliveryKey);
    const replayed = Boolean(delivery);
    let command: AdminEmailCommand<T>;
    if (!delivery) {
      command = await run();
      delivery = { status: "pending" };
      this.deliveries.set(deliveryKey, delivery);
    } else {
      command = { email: account.email, result: null as T };
    }
    try {
      await send(command.email);
      delivery.status = "sent";
      this.audits.push({ action: `${audit.action}:success`, reason: audit.reason });
      return { replayed, result: command.result };
    } catch (error) {
      delivery.status = "failed";
      this.audits.push({
        action: `${audit.action}:failure`,
        reason: error instanceof Error ? error.message : audit.reason,
      });
      throw error;
    }
  }
}

describe("ADMIN-001/002 service", () => {
  it("returns minimum metadata to support and never exposes domestic values", async () => {
    const store = new MemoryAdminStore();
    const service = new AdminService(store, new MemoryAuthPort());
    const result = await service.searchAccounts(actor("platform_support"), {
      query: "person@example.com",
      limit: 50,
    });
    expect(result.items[0]).toMatchObject({ userId: "target-user", email: "person@example.com" });
    expect(result.items[0]).not.toHaveProperty("password");
    expect(result.items[0]).not.toHaveProperty("transactions");
  });

  it("requires enrolled TOTP before a platform admin can use the console", async () => {
    const service = new AdminService(new MemoryAdminStore(), new MemoryAuthPort());
    await expect(
      service.searchAccounts(
        { ...actor("platform_admin"), twoFactorEnabled: false },
        { query: "person@example.com", limit: 50 },
      ),
    ).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("requires enrolled TOTP before support can use the console", async () => {
    const service = new AdminService(new MemoryAdminStore(), new MemoryAuthPort());
    await expect(
      service.searchAccounts(
        { ...actor("platform_support"), twoFactorEnabled: false },
        { query: "person@example.com", limit: 50 },
      ),
    ).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("requires recent authentication for suspension and protects the last admin", async () => {
    const store = new MemoryAdminStore();
    store.current.role = "platform_admin";
    store.activeAdminCount = 1;
    const service = new AdminService(store, new MemoryAuthPort());
    await expect(
      service.suspendAccount(
        actor("platform_admin", false),
        "target-user",
        { reason: "abuse" },
        "suspend-key-0001",
        "01J00000000000000000000000",
      ),
    ).rejects.toMatchObject({ code: "recent_auth_required" });
    await expect(
      service.changePlatformRole(
        actor("platform_admin"),
        "target-user",
        { role: null, reason: "offboarding" },
        "role-key-0001",
        "01J00000000000000000000000",
      ),
    ).rejects.toMatchObject({ code: "last_platform_admin" });
  });

  it("does not let support promote accounts and deduplicates mutating retries", async () => {
    const store = new MemoryAdminStore();
    const service = new AdminService(store, new MemoryAuthPort());
    await expect(
      service.changePlatformRole(
        actor("platform_support"),
        "target-user",
        { role: "platform_admin", reason: "promotion" },
        "role-key-0002",
        "01J00000000000000000000000",
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const first = await service.reactivateAccount(
      actor("platform_support"),
      "target-user",
      { reason: "reviewed" },
      "reactivate-key-0001",
      "01J00000000000000000000000",
    );
    const replay = await service.reactivateAccount(
      actor("platform_support"),
      "target-user",
      { reason: "reviewed" },
      "reactivate-key-0001",
      "01J00000000000000000000000",
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(store.calls).toBe(1);
    expect(store.audits).toEqual([{ action: "account:active", reason: "reviewed" }]);
  });

  it("keeps correlation IDs out of the command fingerprint", async () => {
    const store = new MemoryAdminStore();
    const service = new AdminService(store, new MemoryAuthPort());
    const first = await service.reactivateAccount(
      actor("platform_support"),
      "target-user",
      { reason: "same command" },
      "reactivate-key-correlation",
      "01J00000000000000000000001",
    );
    const replay = await service.reactivateAccount(
      actor("platform_support"),
      "target-user",
      { reason: "same command" },
      "reactivate-key-correlation",
      "01J00000000000000000000002",
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(store.calls).toBe(1);
  });

  it("records a failure audit when an administrative command is rejected", async () => {
    const store = new MemoryAdminStore();
    store.updateStatus = async () => {
      throw new Error("account update failed");
    };
    const service = new AdminService(store, new MemoryAuthPort());

    await expect(
      service.suspendAccount(
        actor("platform_support"),
        "target-user",
        { reason: "security review" },
        "suspend-key-failure-audit",
        "01J00000000000000000000000",
      ),
    ).rejects.toThrow("account update failed");

    expect(store.audits).toEqual([
      { action: "account:suspended", reason: "security review [failure:internal_error]" },
    ]);
    expect(store.auditResults).toEqual(["failure"]);
  });

  it("revokes sessions and delegates verification/recovery to Better Auth flows", async () => {
    const store = new MemoryAdminStore();
    const auth = new MemoryAuthPort();
    const service = new AdminService(store, auth);
    await service.revokeSession(
      actor("platform_support"),
      "target-user",
      "session-1",
      { reason: "security review" },
      "session-key-0001",
      "01J00000000000000000000000",
    );
    await service.resendVerification(
      actor("platform_support"),
      "target-user",
      { reason: "requested" },
      "verify-key-0001",
      "01J00000000000000000000000",
    );
    await service.resendRecovery(
      actor("platform_support"),
      "target-user",
      { reason: "requested" },
      "recover-key-0001",
      "01J00000000000000000000000",
    );
    expect(auth.verification).toBe(1);
    expect(auth.recovery).toBe(1);
    expect(auth.verificationCorrelations).toEqual(["01J00000000000000000000000"]);
    expect(auth.recoveryCorrelations).toEqual(["01J00000000000000000000000"]);
  });

  it("derives an email dispatch key scoped to actor, action, target, and command", async () => {
    const store = new MemoryAdminStore();
    const auth = new MemoryAuthPort();
    const service = new AdminService(store, auth);
    await service.resendVerification(
      actor("platform_support"),
      "target-user",
      { reason: "requested" },
      "verify-key-deterministic",
      "01J00000000000000000000000",
    );
    expect(auth.verificationKeys[0]).toMatch(/^admin-email-[a-f0-9]{64}$/);
    expect(auth.verificationKeys[0]).not.toBe("verify-key-deterministic");
    await service.resendRecovery(
      actor("platform_support"),
      "target-user",
      { reason: "requested" },
      "verify-key-deterministic",
      "01J00000000000000000000000",
    );
    expect(auth.recoveryKeys[0]).not.toBe(auth.verificationKeys[0]);
  });

  it("keeps email idempotency pending/failed until the auth boundary accepts it", async () => {
    const store = new PendingEmailStore();
    const auth = new MemoryAuthPort();
    const originalSend = auth.sendVerificationEmail.bind(auth);
    let fail = true;
    auth.sendVerificationEmail = async (email, key) => {
      if (fail) {
        fail = false;
        throw new Error("provider unavailable");
      }
      await originalSend(email, key);
    };
    const service = new AdminService(store, auth);
    await expect(
      service.resendVerification(
        actor("platform_support"),
        "target-user",
        { reason: "requested" },
        "verify-key-stateful",
        "01J00000000000000000000000",
      ),
    ).rejects.toThrow("provider unavailable");
    expect([...store.deliveries.values()][0]?.status).toBe("failed");
    await expect(
      service.resendVerification(
        actor("platform_support"),
        "target-user",
        { reason: "requested" },
        "verify-key-stateful",
        "01J00000000000000000000001",
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect([...store.deliveries.values()][0]?.status).toBe("sent");
    expect(store.audits.map((entry) => entry.action)).toEqual([
      "auth:verification-resend:failure",
      "auth:verification-resend:success",
    ]);
  });

  it("audits a failed verification resend when the target account does not exist", async () => {
    const store = new PendingEmailStore();
    const service = new AdminService(store, new MemoryAuthPort());

    await expect(
      service.resendVerification(
        actor("platform_support"),
        "missing-user",
        { reason: "requested" },
        "verify-key-missing-target",
        "01J00000000000000000000000",
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(store.audits).toEqual([
      {
        action: "auth:verification-resend",
        reason: "requested [failure:not_found]",
      },
    ]);
    expect(store.auditResults).toEqual(["failure"]);
  });
});
