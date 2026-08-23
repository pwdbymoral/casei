import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticatedWorkspaceAdapter,
  getActiveWorkspace,
  unauthenticatedPlatformAdminSessionPort,
  unauthenticatedWorkspaceAdapter,
  type WorkspaceSession,
} from "./workspaces";

const session: WorkspaceSession = {
  user: { id: "user", displayName: "Ana", email: "ana@example.com" },
  workspaces: [
    {
      id: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
      name: "Casa",
      role: "owner",
      locale: "pt-BR",
      timeZone: "America/Fortaleza",
    },
  ],
  activeWorkspaceId: "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201",
};

describe("workspace shell boundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it("resolves only the active workspace from the session", () => {
    expect(getActiveWorkspace(session)?.name).toBe("Casa");
    expect(getActiveWorkspace({ ...session, activeWorkspaceId: "unknown" })).toBeNull();
  });

  it("denies the production adapter instead of exposing fixture data", async () => {
    await expect(unauthenticatedWorkspaceAdapter.getSession()).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(unauthenticatedPlatformAdminSessionPort.getSession()).resolves.toBeNull();
  });

  it("loads and switches only among API-authorized workspaces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...session, activeWorkspaceId: undefined }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(authenticatedWorkspaceAdapter.getSession()).resolves.toMatchObject({
      activeWorkspaceId: session.activeWorkspaceId,
    });
    await expect(
      authenticatedWorkspaceAdapter.switchWorkspace("not-authorized"),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("maps an expired session to an unauthenticated state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(authenticatedWorkspaceAdapter.getSession()).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});
