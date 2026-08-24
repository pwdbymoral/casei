import { headers } from "next/headers";

import type { WorkspaceSession } from "./workspaces";

function apiOrigin(): string {
  return (process.env.CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

/** Server guard: forwards only the incoming session cookie to the API boundary. */
export async function getServerWorkspaceSession(): Promise<WorkspaceSession | null> {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  if (!cookie) return null;
  try {
    const response = await fetch(`${apiOrigin()}/v1/me/workspaces`, {
      headers: { Accept: "application/json", Cookie: cookie },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Omit<WorkspaceSession, "activeWorkspaceId">;
    const normalizedWorkspaces = body.workspaces.map((workspace) => ({
      ...workspace,
      status: workspace.status ?? "active",
      version: workspace.version ?? 0,
    }));
    const activeWorkspaceId =
      normalizedWorkspaces.find(({ status }) => status === "active")?.id ??
      normalizedWorkspaces[0]?.id ??
      null;
    return {
      ...body,
      workspaces: normalizedWorkspaces,
      activeWorkspaceId,
    };
  } catch {
    return null;
  }
}
