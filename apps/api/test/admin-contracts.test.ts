import {
  adminAccountActionSchema,
  adminAccountDetailSchema,
  adminAccountSearchQuerySchema,
  adminAccountSummarySchema,
  adminPlatformRoleUpdateSchema,
  adminSessionSchema,
  platformAccountStatusSchema,
  platformRoleSchema,
} from "@casei/contracts";
import { describe, expect, it } from "vitest";

const account = {
  userId: "user-1",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  role: "platform_admin" as const,
  status: "active" as const,
  createdAt: "2026-08-25T12:00:00.000Z",
  lastActivityAt: "2026-08-25T12:30:00.000Z",
  workspaceCount: 2,
  activeSessionCount: 1,
};

describe("ADMIN-001/002 contracts", () => {
  it("keeps platform roles and account states independent from workspace roles", () => {
    expect(platformRoleSchema.parse("platform_admin")).toBe("platform_admin");
    expect(platformRoleSchema.parse("platform_support")).toBe("platform_support");
    expect(platformAccountStatusSchema.parse("suspended")).toBe("suspended");
    expect(() => platformRoleSchema.parse("owner")).toThrow();
  });

  it("accepts only normalized account search and bounded pagination", () => {
    expect(
      adminAccountSearchQuerySchema.parse({ query: " ADA@EXAMPLE.COM ", limit: "25" }),
    ).toEqual({
      query: "ADA@EXAMPLE.COM",
      limit: 25,
    });
    expect(() => adminAccountSearchQuerySchema.parse({ query: "" })).toThrow();
    expect(() => adminAccountSearchQuerySchema.parse({ query: "ada", limit: "101" })).toThrow();
  });

  it("requires a reason for every account action and role change", () => {
    expect(adminAccountActionSchema.parse({ reason: "solicitação do titular" })).toEqual({
      reason: "solicitação do titular",
    });
    expect(
      adminPlatformRoleUpdateSchema.parse({ role: null, reason: "encerramento da escala" }),
    ).toEqual({
      role: null,
      reason: "encerramento da escala",
    });
    expect(() => adminAccountActionSchema.parse({ reason: " " })).toThrow();
    expect(() => adminPlatformRoleUpdateSchema.parse({ role: "owner", reason: "x" })).toThrow();
  });

  it("does not allow account contracts to carry secrets or domestic content", () => {
    expect(adminAccountSummarySchema.parse(account)).toEqual(account);
    const summary = adminAccountSummarySchema.parse({ ...account, password: "secret" });
    expect(summary).not.toHaveProperty("password");

    const detail = adminAccountDetailSchema.parse({
      ...account,
      workspaces: [{ id: "0190f3c8-2a10-7abc-8def-1234567890ab", name: "Casa", status: "active" }],
      sessions: [
        {
          id: "session-1",
          createdAt: account.createdAt,
          updatedAt: account.lastActivityAt,
          expiresAt: "2026-09-25T12:00:00.000Z",
          ipAddress: "203.0.113.0/24",
          userAgent: "browser",
        },
      ],
    });
    expect(detail.sessions[0]?.ipAddress).toBe("203.0.113.0/24");
    expect(() => adminSessionSchema.parse({ id: "s", token: "bearer" })).toThrow();
  });
});
