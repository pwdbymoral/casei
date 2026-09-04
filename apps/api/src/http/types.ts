import type { CorrelationId, PlatformRole, WorkspaceRole } from "@casei/contracts";
import type { Context, Env } from "hono";

export interface RequestActor {
  /** Better Auth's user ID is deliberately opaque at this boundary. */
  userId: string;
  email?: string;
  displayName?: string;
  recentAuthentication?: boolean;
  /** One-use server-issued proof for mutating platform commands. */
  stepUpToken?: string;
  /** Better Auth's persisted enrollment state, never accepted from the client. */
  twoFactorEnabled?: boolean;
  /** Request provenance retained for administrative audit, never authorization. */
  ipAddress?: string | null;
  endpoint?: string | null;
  /** Platform role is separate from workspace membership and is absent for ordinary users. */
  platformRole?: PlatformRole | null;
}

export interface WorkspaceScope {
  actor: RequestActor;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface ApiVariables {
  correlationId: CorrelationId;
  actor: RequestActor;
  workspaceScope: WorkspaceScope;
}

export type ApiEnv = Env & { Variables: ApiVariables };
export type ApiContext = Context<ApiEnv>;

export type MaybePromise<T> = T | Promise<T>;
export type ActorResolver = (context: ApiContext) => MaybePromise<RequestActor | null>;
export type WorkspaceScopeResolver = (input: {
  actor: RequestActor;
  context: ApiContext;
  workspaceId: string;
}) => MaybePromise<WorkspaceScope | null>;
