import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { IdentityPermissionError, IdentityVersionConflictError } from "../src/identity-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";

describe("AUTH-002..005 HTTP boundary", () => {
  it("requires an authenticated actor and keeps onboarding idempotency explicit", async () => {
    const unauthenticated = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => null,
      },
    });
    const denied = await unauthenticated.request("http://localhost/v1/me/workspaces");
    expect(denied.status).toBe(401);

    const preflight = await unauthenticated.request("http://localhost/v1/onboarding", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, idempotency-key",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");

    const app = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => ({
          userId: "user-1",
          email: "ada@example.com",
          displayName: "Ada",
          recentAuthentication: true,
        }),
      },
    });
    const missingKey = await app.request("http://localhost/v1/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Ada",
        workspaceName: "Casa",
        currency: "BRL",
        timeZone: "America/Fortaleza",
        initialBalanceMinor: "0",
        includeInitialBalance: false,
      }),
    });
    expect(missingKey.status).toBe(422);
  });

  it("rejects a workspace body without an authenticated scope instead of trusting a client id", async () => {
    const app = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => null,
      },
    });
    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/recovery`);
    expect(response.status).toBe(401);
  });

  it("lists members and invitations only for an owner-scoped workspace", async () => {
    const owner = createAppWithRole("owner");
    const members = await owner.request(`http://localhost/v1/workspaces/${workspaceId}/members`);
    expect(members.status).toBe(200);
    expect(await members.json()).toEqual({
      members: [
        {
          userId: "user-member",
          displayName: "Pessoa membro",
          email: "member@example.com",
          role: "member",
          status: "active",
          version: 0,
        },
      ],
    });

    const invitations = await owner.request(
      `http://localhost/v1/workspaces/${workspaceId}/invitations`,
    );
    expect(invitations.status).toBe(200);
    expect(await invitations.json()).toEqual({
      invitations: [
        {
          id: workspaceId,
          workspaceId,
          email: "pending@example.com",
          role: "viewer",
          status: "pending",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });

    const member = createAppWithRole("member");
    const denied = await member.request(`http://localhost/v1/workspaces/${workspaceId}/members`);
    expect(denied.status).toBe(403);

    const foreign = await owner.request(
      "http://localhost/v1/workspaces/0190f3c8-2a10-7abc-8def-1234567890ac/members",
    );
    expect(foreign.status).toBe(404);
  });

  it("requires If-Match for role changes and makes invitation revocation idempotent", async () => {
    const app = createAppWithRole("owner");
    const missingVersion = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/members/user-member`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(missingVersion.status).toBe(428);

    const conflict = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/members/user-member`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "If-Match": '"v1"' },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(conflict.status).toBe(412);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "version_conflict", currentVersion: 2 },
    });

    const revoked = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/invitations/${workspaceId}`,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": "revoke-invitation-01" },
      },
    );
    expect(revoked.status).toBe(204);
  });

  it("requires If-Match before removing, transferring, or deactivating a workspace", async () => {
    const app = createAppWithRole("owner");
    const headers = { "content-type": "application/json" };
    await expect(
      app.request(`http://localhost/v1/workspaces/${workspaceId}/members/user-member`, {
        method: "DELETE",
        headers,
      }),
    ).resolves.toHaveProperty("status", 428);
    await expect(
      app.request(`http://localhost/v1/workspaces/${workspaceId}/ownership/transfer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: "user-member" }),
      }),
    ).resolves.toHaveProperty("status", 428);
    await expect(
      app.request(`http://localhost/v1/workspaces/${workspaceId}/deactivation`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workspaceName: "Casa", reason: "teste" }),
      }),
    ).resolves.toHaveProperty("status", 428);
  });

  it("retries deactivation through recovery entitlement without an active scope", async () => {
    const app = createAppWithRole("owner", false);
    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/deactivation`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "If-Match": '"v1"' },
        body: JSON.stringify({ workspaceName: "Casa", reason: "retry" }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recoveryUntil: "2030-01-31T00:00:00.000Z" });
  });
});

function createAppWithRole(role: "owner" | "member" | "viewer", scopeAvailable = true) {
  const service = {
    resolveScope: async (_actor: unknown, requestedWorkspaceId: string) =>
      scopeAvailable && requestedWorkspaceId === workspaceId
        ? {
            actor: { userId: "user-owner", email: "owner@example.com" },
            workspaceId,
            role,
            correlationId: "",
          }
        : null,
    listMembers: async (scope: { role: string }) => {
      if (scope.role !== "owner") throw new IdentityPermissionError();
      return {
        members: [
          {
            userId: "user-member",
            displayName: "Pessoa membro",
            email: "member@example.com",
            role: "member",
            status: "active",
            version: 0,
          },
        ],
      };
    },
    listInvitations: async (scope: { role: string }) => {
      if (scope.role !== "owner") throw new IdentityPermissionError();
      return {
        invitations: [
          {
            id: workspaceId,
            workspaceId,
            email: "pending@example.com",
            role: "viewer",
            status: "pending",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        ],
      };
    },
    changeMemberRole: async () => {
      throw new IdentityVersionConflictError(2);
    },
    revokeInvitation: async () => ({ replayed: false }),
    retryDeactivation: async () => ({ recoveryUntil: "2030-01-31T00:00:00.000Z", version: 1 }),
  };
  return createApp(undefined, {
    identity: {
      pool: {} as never,
      service: service as never,
      actorResolver: async () => ({
        userId: "user-owner",
        email: "owner@example.com",
        displayName: "Pessoa owner",
      }),
    },
  });
}
