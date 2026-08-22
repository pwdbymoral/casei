import { z } from "zod";

export const workspaceRoleSchema = z.enum(["owner", "member"]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceMembershipSchema = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: workspaceRoleSchema,
});

export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;
