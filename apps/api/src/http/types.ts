import type { CorrelationId, WorkspaceRole } from "@casei/contracts";
import type { Context, Env } from "hono";

export interface RequestActor {
  /** Better Auth's user ID is deliberately opaque at this boundary. */
  userId: string;
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
