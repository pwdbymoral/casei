import { describe, expect, it } from "vitest";
import { AdminPolicyError } from "../src/admin-policy.js";
import type { AdminService } from "../src/admin-service.js";
import { createApp } from "../src/app.js";

const account = {
  userId: "target-user",
  displayName: "Pessoa",
  email: "person@example.com",
  role: null,
  status: "active",
  createdAt: "2026-08-25T12:00:00.000Z",
  lastActivityAt: null,
  workspaceCount: 0,
  activeSessionCount: 0,
  workspaces: [],
  sessions: [],
} as const;

function createAdminApp(
  platformRole: "platform_admin" | "platform_support" | null = "platform_admin",
  twoFactorEnabled = true,
) {
  const service = {
    searchAccounts: async () => {
      if (platformRole === "platform_admin" && !twoFactorEnabled)
        throw new AdminPolicyError("step_up_required");
      return { items: [account], page: { nextCursor: null, hasMore: false } };
    },
    getAccount: async () => account,
    getPlatformSession: () => ({
      userId: "admin-user",
      displayName: "Admin",
      role: platformRole ?? "platform_admin",
      twoFactorEnabled,
    }),
    startTwoFactorEnrollment: async () => ({
      totpURI: "otpauth://totp/Casei",
      backupCodes: ["one"],
    }),
    verifyTwoFactorEnrollment: async () => ["casei_session=verified; Path=/; HttpOnly"],
    completeStepUp: async () => ({ token: "step-up-token", expiresInSeconds: 300 }),
    suspendAccount: async () => ({ replayed: false, result: account }),
    reactivateAccount: async () => ({ replayed: false, result: account }),
    changePlatformRole: async () => {
      if (platformRole !== "platform_admin") throw new AdminPolicyError("permission_denied");
      return { replayed: false, result: account };
    },
    revokeSession: async () => ({ replayed: false, result: null }),
    resendVerification: async () => ({ replayed: false, result: null }),
    resendRecovery: async () => ({ replayed: false, result: null }),
  } as unknown as AdminService;
  return createApp(undefined, {
    identity: {
      pool: {} as never,
      actorResolver: async () =>
        platformRole
          ? {
              userId: "admin-user",
              email: "admin@example.com",
              displayName: "Admin",
              platformRole,
              recentAuthentication: true,
              twoFactorEnabled,
            }
          : null,
    },
    admin: { service: service as AdminService },
  });
}

describe("ADMIN-002 HTTP boundary", () => {
  it("fails closed without an authenticated platform actor", async () => {
    const response = await createAdminApp(null).request(
      "http://localhost/v1/admin/accounts?query=ada",
    );
    expect(response.status).toBe(401);
  });

  it("searches accounts through a separate boundary and includes no workspace scope", async () => {
    const response = await createAdminApp("platform_support").request(
      "http://localhost/v1/admin/accounts?query=PERSON%40EXAMPLE.COM&limit=25",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [account],
      page: { nextCursor: null, hasMore: false },
    });
  });

  it("exposes only the server-resolved platform session", async () => {
    const response = await createAdminApp().request("http://localhost/v1/admin/session");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "admin-user",
      displayName: "Admin",
      role: "platform_admin",
      twoFactorEnabled: true,
    });
  });

  it("keeps step-up proof inside the administrative boundary", async () => {
    const response = await createAdminApp().request("http://localhost/v1/admin/step-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "totp", code: "123456" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "step-up-token",
      expiresInSeconds: 300,
    });
  });

  it("blocks the console until a platform admin enrolls TOTP", async () => {
    const response = await createAdminApp("platform_admin", false).request(
      "http://localhost/v1/admin/accounts?query=ada",
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "step_up_required" },
    });
  });

  it("keeps enrollment endpoints available before the console gate", async () => {
    const app = createAdminApp("platform_admin", false);
    const enroll = await app.request("http://localhost/v1/admin/two-factor/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-password" }),
    });
    expect(enroll.status).toBe(200);
    await expect(enroll.json()).resolves.toMatchObject({
      totpURI: expect.stringContaining("otpauth://"),
    });
    const verify = await app.request("http://localhost/v1/admin/two-factor/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(verify.status).toBe(204);
    expect(verify.headers.get("set-cookie")).toContain("casei_session=verified");
  });

  it("requires a reason and idempotency key for suspend", async () => {
    const app = createAdminApp();
    const missingReason = await app.request(
      "http://localhost/v1/admin/accounts/target-user/suspend",
      {
        method: "POST",
        headers: { "Idempotency-Key": "admin-suspend-key-01" },
        body: JSON.stringify({}),
      },
    );
    expect(missingReason.status).toBe(422);
    const missingKey = await app.request("http://localhost/v1/admin/accounts/target-user/suspend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "abuse review" }),
    });
    expect(missingKey.status).toBe(422);
  });

  it("keeps platform role changes restricted to platform_admin", async () => {
    const response = await createAdminApp("platform_support").request(
      "http://localhost/v1/admin/accounts/target-user/platform-role",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "admin-role-change-01",
        },
        body: JSON.stringify({ role: "platform_admin", reason: "promotion" }),
      },
    );
    expect(response.status).toBe(403);
  });
});
