import type { AdminAccountDetail, AdminAccountList, PlatformRole } from "@casei/contracts";
import { describe, expect, it } from "vitest";
import {
  type AdminAccountStore,
  type AdminAuthPort,
  AdminNotFoundError,
  AdminService,
} from "../src/admin-service.js";

const actor = (role: PlatformRole, recentAuthentication = true) => ({
  userId: "admin-user",
  email: "admin@example.com",
  displayName: "Admin",
  platformRole: role,
  recentAuthentication,
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

  async recordAudit(input: { action: string; reason: string }): Promise<void> {
    this.audits.push({ action: input.action, reason: input.reason });
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
  async sendVerificationEmail(email: string): Promise<void> {
    if (email !== account.email) throw new AdminNotFoundError();
    this.verification += 1;
  }
  async sendPasswordReset(email: string): Promise<void> {
    if (email !== account.email) throw new AdminNotFoundError();
    this.recovery += 1;
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
  });
});
