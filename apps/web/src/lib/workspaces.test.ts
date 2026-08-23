import { describe, expect, it } from "vitest";

import { getActiveWorkspace, type WorkspaceSession } from "./workspaces";

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
  it("resolves only the active workspace from the session", () => {
    expect(getActiveWorkspace(session)?.name).toBe("Casa");
    expect(getActiveWorkspace({ ...session, activeWorkspaceId: "unknown" })).toBeNull();
  });
});
