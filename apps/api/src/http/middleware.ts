import { workspaceIdSchema } from "@casei/contracts";
import type { MiddlewareHandler } from "hono";
import { ApiHttpError, notFoundError, unauthenticatedError } from "./errors.js";
import type { ActorResolver, ApiContext, ApiEnv, WorkspaceScopeResolver } from "./types.js";

export function createActorMiddleware(resolveActor: ActorResolver): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const actor = await resolveActor(context);
    if (!actor) {
      throw unauthenticatedError();
    }
    context.set("actor", actor);
    await next();
  };
}

export function createWorkspaceScopeMiddleware(
  resolveScope: WorkspaceScopeResolver,
): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const actor = context.get("actor");
    const workspaceId = context.req.param("workspaceId");
    if (!actor || !workspaceId || !workspaceIdSchema.safeParse(workspaceId).success) {
      throw notFoundError();
    }

    const scope = await resolveScope({ actor, context, workspaceId });
    if (!scope) {
      throw notFoundError();
    }
    context.set("workspaceScope", scope);
    await next();
  };
}

/**
 * A route owns the workspace in its path. A body may repeat that ID for
 * backwards-compatible contracts, but it can never select another scope.
 */
export function assertWorkspaceIdMatch(context: ApiContext, body: unknown): void {
  if (typeof body !== "object" || body === null || !("workspaceId" in body)) {
    return;
  }

  const bodyWorkspaceId = (body as { workspaceId?: unknown }).workspaceId;
  const routeWorkspaceId = context.req.param("workspaceId");
  if (bodyWorkspaceId !== routeWorkspaceId) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { workspaceId: ["O espaço informado não corresponde à rota."] },
    });
  }
}
