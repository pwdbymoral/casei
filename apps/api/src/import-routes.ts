import { importCreateRequestSchema, importLineListQuerySchema } from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { ApiHttpError, errorResponse, notFoundError } from "./http/index.js";
import { parseJsonBody, parseQuery } from "./http/parsing.js";
import type { ApiContext, ApiEnv } from "./http/types.js";
import {
  type ImportApplication,
  ImportAuthorizationError,
  ImportConflictError,
  ImportFailure,
} from "./import-service.js";

export interface ImportRoutesOptions {
  application: ImportApplication;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** API command/query boundary for DATA-004; worker execution is deliberately separate. */
export function configureImportRoutes(router: Hono<ApiEnv>, options: ImportRoutesOptions): void {
  router.onError((error, context) => errorResponse(context, importErrorToHttp(error)));
  for (const path of ["/workspaces/:workspaceId/imports", "/workspaces/:workspaceId/imports/*"]) {
    router.use(path, options.scopeMiddleware);
  }

  router.post("/workspaces/:workspaceId/imports", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    const request = await parseJsonBody(context, importCreateRequestSchema);
    const job = await options.application.create({
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      correlationId: scope.correlationId,
      request,
      idempotencyKey: requiredIdempotencyKey(context),
    });
    return context.json(job, 202);
  });

  router.get("/workspaces/:workspaceId/imports/:importId", async (context) => {
    const scope = scopeOf(context);
    const importId = context.req.param("importId");
    const job = await options.application.getJob(importId, scope.workspaceId);
    if (!job) throw notFoundError();
    return context.json(job);
  });

  router.get("/workspaces/:workspaceId/imports/:importId/lines", async (context) => {
    const scope = scopeOf(context);
    const query = parseQuery(context, importLineListQuerySchema);
    const page = await options.application.listResults(
      context.req.param("importId"),
      scope.workspaceId,
      query.afterLine,
      query.limit,
    );
    return context.json({
      items: page.items.map(({ reversalToken: _reversalToken, ...line }) => line),
      page: { nextAfterLine: page.nextAfterLine },
    });
  });

  router.post("/workspaces/:workspaceId/imports/:importId/cancel", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    requiredIdempotencyKey(context);
    const job = await options.application.cancel(context.req.param("importId"), scope.workspaceId, {
      actorId: scope.actorId,
      correlationId: scope.correlationId,
    });
    return context.json(job, 202);
  });

  router.post("/workspaces/:workspaceId/imports/:importId/reverse", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    requiredIdempotencyKey(context);
    const job = await options.application.reverse(
      context.req.param("importId"),
      scope.workspaceId,
      {
        actorId: scope.actorId,
        correlationId: scope.correlationId,
      },
    );
    return context.json(job, 202);
  });
}

function scopeOf(context: ApiContext): {
  workspaceId: string;
  actorId: string;
  correlationId: string;
  role: "owner" | "member" | "viewer";
} {
  const scope = context.get("workspaceScope");
  const correlationId = context.get("correlationId");
  const actor = context.get("actor");
  if (!scope || !correlationId || !actor) throw new ApiHttpError(401, "unauthenticated");
  return {
    workspaceId: scope.workspaceId,
    actorId: actor.userId,
    correlationId,
    role: scope.role,
  };
}

function requiredIdempotencyKey(context: ApiContext): string {
  const value = context.req.header("Idempotency-Key");
  if (!value || !/^[\x21-\x7e]{16,128}$/.test(value)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { "Idempotency-Key": ["Informe uma chave ASCII de 16 a 128 caracteres."] },
    });
  }
  return value;
}

export function importErrorToHttp(error: unknown): unknown {
  if (error instanceof ImportAuthorizationError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof ImportConflictError)
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  if (error instanceof ImportFailure)
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  return error;
}
