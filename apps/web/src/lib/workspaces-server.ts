import { headers } from "next/headers";
import { configuredApiOrigin } from "./api-origin";
import { normalizeWorkspaceSession, type WorkspaceSession } from "./workspaces";

/** Server guard: forwards only the incoming session cookie to the API boundary. */
export async function getServerWorkspaceSession(): Promise<WorkspaceSession | null> {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  if (!cookie) return null;
  const origin = configuredApiOrigin();
  if (!origin) return null;
  try {
    const response = await fetch(`${origin}/v1/me/workspaces`, {
      headers: { Accept: "application/json", Cookie: cookie },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Omit<WorkspaceSession, "activeWorkspaceId">;
    const normalized = normalizeWorkspaceSession(body);
    const normalizedWorkspaces = normalized.workspaces;
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
