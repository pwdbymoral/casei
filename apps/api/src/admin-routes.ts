import {
  adminAccountActionSchema,
  adminAccountSearchQuerySchema,
  adminPlatformRoleUpdateSchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AdminService } from "./admin-service.js";
import type { ApiContext, ApiEnv, RequestActor } from "./http/index.js";
import { ApiHttpError, parseJsonBody, parseQuery } from "./http/index.js";

export interface AdminRoutesOptions {
  service: AdminService;
  actorMiddleware: MiddlewareHandler<ApiEnv>;
}

export function configureAdminRoutes(router: Hono<ApiEnv>, options: AdminRoutesOptions): void {
  const { service } = options;
  router.use("/admin/*", options.actorMiddleware);

  router.get("/admin/session", (context) =>
    context.json(service.getPlatformSession(actorOf(context))),
  );

  router.post("/admin/step-up", async (context) => {
    const input = await parseJsonBody(
      context,
      z.object({
        method: z.enum(["totp", "backup_code"]),
        code: z.string().trim().min(6).max(128),
      }),
    );
    const result = await service.completeStepUp(
      actorOf(context),
      input,
      context.req.raw.headers,
      context.get("correlationId"),
    );
    return context.json(result);
  });

  router.post("/admin/two-factor/enroll", async (context) => {
    const input = await parseJsonBody(context, z.object({ password: z.string().min(1).max(256) }));
    return context.json(
      await service.startTwoFactorEnrollment(
        actorOf(context),
        input.password,
        context.req.raw.headers,
      ),
    );
  });

  router.post("/admin/two-factor/verify", async (context) => {
    const input = await parseJsonBody(
      context,
      z.object({ code: z.string().trim().min(6).max(128) }),
    );
    const result = await service.verifyTwoFactorEnrollment(
      actorOf(context),
      input.code,
      context.req.raw.headers,
    );
    for (const cookie of result) context.header("Set-Cookie", cookie, { append: true });
    return context.body(null, 204);
  });

  router.get("/admin/accounts", async (context) => {
    const result = await service.searchAccounts(
      actorOf(context),
      parseQuery(context, adminAccountSearchQuerySchema),
    );
    return context.json(result);
  });

  router.get("/admin/accounts/:userId", async (context) => {
    return context.json(await service.getAccount(actorOf(context), context.req.param("userId")));
  });

  router.get("/admin/accounts/:userId/sessions", async (context) => {
    const account = await service.getAccount(actorOf(context), context.req.param("userId"));
    return context.json({ sessions: account.sessions });
  });

  router.post("/admin/accounts/:userId/suspend", async (context) => {
    const result = await service.suspendAccount(
      actorOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, adminAccountActionSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.result);
  });

  router.post("/admin/accounts/:userId/reactivate", async (context) => {
    const result = await service.reactivateAccount(
      actorOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, adminAccountActionSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.result);
  });

  router.patch("/admin/accounts/:userId/platform-role", async (context) => {
    const result = await service.changePlatformRole(
      actorOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, adminPlatformRoleUpdateSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.result);
  });

  router.delete("/admin/accounts/:userId/sessions/:sessionId", async (context) => {
    const result = await service.revokeSession(
      actorOf(context),
      context.req.param("userId"),
      context.req.param("sessionId"),
      await parseJsonBody(context, adminAccountActionSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.body(null, 204);
  });

  router.post("/admin/accounts/:userId/verification/resend", async (context) => {
    const result = await service.resendVerification(
      actorOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, adminAccountActionSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.body(null, 204);
  });

  router.post("/admin/accounts/:userId/recovery/resend", async (context) => {
    const result = await service.resendRecovery(
      actorOf(context),
      context.req.param("userId"),
      await parseJsonBody(context, adminAccountActionSchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.body(null, 204);
  });
}

function actorOf(context: ApiContext): RequestActor {
  const actor = context.get("actor");
  if (!actor) throw new Error("actor middleware is required");
  return actor;
}

function requiredIdempotencyKey(context: ApiContext): string {
  const key = context.req.header("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{16,128}$/.test(key)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { "Idempotency-Key": ["Informe uma chave ASCII de 16 a 128 caracteres."] },
    });
  }
  return key;
}
