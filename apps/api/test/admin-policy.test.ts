import { describe, expect, it } from "vitest";
import {
  AdminPolicyError,
  assertCanPerformPlatformAction,
  assertLastPlatformAdminCanChange,
  assertPlatformTwoFactor,
  assertRecentPlatformAuthentication,
  normalizeAdminAccountSearch,
  type PlatformAdminAction,
} from "../src/admin-policy.js";

describe("ADMIN-001 platform policy", () => {
  it("keeps support read-only for role management while allowing support operations", () => {
    const supportActions: PlatformAdminAction[] = [
      "account:read",
      "account:suspend",
      "account:reactivate",
      "session:revoke",
      "auth:resend",
    ];
    for (const action of supportActions) {
      expect(() => assertCanPerformPlatformAction("platform_support", action)).not.toThrow();
    }
    expect(() =>
      assertCanPerformPlatformAction("platform_support", "platform-role:change"),
    ).toThrowError(new AdminPolicyError("permission_denied"));
    expect(() =>
      assertCanPerformPlatformAction("platform_admin", "platform-role:change"),
    ).not.toThrow();
  });

  it("requires recent authentication for every mutating administrative action", () => {
    expect(() => assertRecentPlatformAuthentication(false)).toThrowError(
      new AdminPolicyError("recent_auth_required"),
    );
    expect(() => assertRecentPlatformAuthentication(true)).not.toThrow();
  });

  it("requires TOTP enrollment for both platform roles", () => {
    expect(() => assertPlatformTwoFactor("platform_admin", false)).toThrowError(
      new AdminPolicyError("step_up_required"),
    );
    expect(() => assertPlatformTwoFactor("platform_support", false)).toThrowError(
      new AdminPolicyError("step_up_required"),
    );
    expect(() => assertPlatformTwoFactor("platform_support", true)).not.toThrow();
  });

  it("does not allow the last active platform admin to be removed or suspended", () => {
    expect(() =>
      assertLastPlatformAdminCanChange({
        activeAdminCount: 1,
        targetIsAdmin: true,
        nextRole: null,
      }),
    ).toThrowError(new AdminPolicyError("last_platform_admin"));
    expect(() =>
      assertLastPlatformAdminCanChange({
        activeAdminCount: 2,
        targetIsAdmin: true,
        nextRole: "platform_support",
      }),
    ).not.toThrow();
    expect(() =>
      assertLastPlatformAdminCanChange({
        activeAdminCount: 1,
        targetIsAdmin: true,
        nextRole: "platform_admin",
      }),
    ).not.toThrow();
  });

  it("normalizes e-mail searches without changing opaque user IDs", () => {
    expect(normalizeAdminAccountSearch("  ADA@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAdminAccountSearch(" user_opaque_01 ")).toBe("user_opaque_01");
  });
});
