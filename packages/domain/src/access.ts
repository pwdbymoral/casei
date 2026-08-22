import type { WorkspaceRole } from "@casei/contracts";

export function canManageWorkspace({ role }: { role: WorkspaceRole }): boolean {
  return role === "owner";
}
