import {
  createInvitationSchema,
  deactivateWorkspaceSchema,
  onboardingSchema,
  updateMembershipRoleSchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { ApiHttpError, notFoundError } from "./http/index.js";
import { parseJsonBody } from "./http/parsing.js";
import type { ApiEnv, RequestActor } from "./http/types.js";
import type { IdentityScope, IdentityService } from "./identity-service.js";

export interface IdentityRoutesOptions {
  service: IdentityService;
  actorMiddleware: MiddlewareHandler<ApiEnv>;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

export function configureIdentityRoutes(
  router: Hono<ApiEnv>,
  options: IdentityRoutesOptions,
): void {
  const { service } = options;
  router.use("/me/*", options.actorMiddleware);
  router.use("/onboarding", options.actorMiddleware);
  router.use("/invitations/*", options.actorMiddleware);
  router.use("/workspaces/:workspaceId/*", options.actorMiddleware);
  router.use("/workspaces/:workspaceId/invitations/*", options.scopeMiddleware);
  router.use("/workspaces/:workspaceId/members/*", options.scopeMiddleware);
  router.use("/workspaces/:workspaceId/ownership/*", options.scopeMiddleware);
  router.use("/workspaces/:workspaceId/deactivation", options.scopeMiddleware);

  router.get("/me/workspaces", async (context) => {
    const actor = actorOf(context);
    return context.json(await service.getSession(actor));
  });

  router.post("/onboarding", async (context) => {
    const actor = actorOf(context);
    const input = await parseJsonBody(context, onboardingSchema);
    const key = requiredIdempotencyKey(context);
    const result = await service.createOnboarding(actor, input, key, context.get("correlationId"));
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.workspace, result.replayed ? 200 : 201);
  });

  router.post("/invitations/:token/accept", async (context) => {
    const actor = actorOf(context);
    const token = context.req.param("token");
    if (!token) throw notFoundError();
    return context.json(
      await service.acceptInvitation(actor, decodeToken(token), context.get("correlationId")),
    );
  });

  router.post("/workspaces/:workspaceId/invitations", async (context) => {
    const scope = scopeOf(context);
    const input = await parseJsonBody(context, createInvitationSchema);
    const result = await service.createInvitation(scope, input, requiredIdempotencyKey(context));
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.invitation, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/invitations/:invitationId/resend", async (context) => {
    const result = await service.resendInvitation(
      scopeOf(context),
      context.req.param("invitationId"),
      requiredIdempotencyKey(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.invitation, result.replayed ? 200 : 201);
  });

  router.delete("/workspaces/:workspaceId/members/:userId", async (context) => {
    await service.removeMember(scopeOf(context), context.req.param("userId"));
    return context.body(null, 204);
  });

  router.patch("/workspaces/:workspaceId/members/:userId", async (context) => {
    const role = await service.changeMemberRole(
      scopeOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, updateMembershipRoleSchema),
    );
    return context.json({ userId: context.req.param("userId"), role });
  });

  router.post("/workspaces/:workspaceId/ownership/transfer", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    const userId =
      typeof body === "object" && body !== null && "userId" in body ? String(body.userId) : "";
    if (!userId) throw notFoundError();
    await service.transferOwnership(scopeOf(context), userId);
    return context.body(null, 204);
  });

  router.post("/workspaces/:workspaceId/deactivation", async (context) => {
    const result = await service.deactivateWorkspace(
      scopeOf(context),
      await parseJsonBody(context, deactivateWorkspaceSchema),
    );
    return context.json(result);
  });

  // Recovery is intentionally not behind operational membership middleware:
  // deactivation revokes the owner membership and leaves only this entitlement.
  router.get("/workspaces/:workspaceId/recovery", async (context) => {
    const actor = actorOf(context);
    const result = await service.getRecovery(actor, context.req.param("workspaceId"));
    if (!result) throw notFoundError();
    return context.json(result);
  });

  router.post("/workspaces/:workspaceId/recovery/cancel", async (context) => {
    await service.cancelDeactivation(
      actorOf(context),
      context.req.param("workspaceId"),
      context.get("correlationId"),
    );
    return context.body(null, 204);
  });
}

function actorOf(context: Parameters<MiddlewareHandler<ApiEnv>>[0]): RequestActor {
  const actor = context.get("actor");
  if (!actor) throw new Error("actor middleware is required");
  return actor;
}

function scopeOf(context: Parameters<MiddlewareHandler<ApiEnv>>[0]): IdentityScope {
  const scope = context.get("workspaceScope");
  if (!scope) throw new Error("workspace scope middleware is required");
  return { ...scope, correlationId: context.get("correlationId") };
}

function requiredIdempotencyKey(context: Parameters<MiddlewareHandler<ApiEnv>>[0]): string {
  const key = context.req.header("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{16,128}$/.test(key)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { "Idempotency-Key": ["Informe uma chave ASCII de 16 a 128 caracteres."] },
    });
  }
  return key;
}

function decodeToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
