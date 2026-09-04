import {
  adminAccountActionSchema,
  adminAccountSearchQuerySchema,
  adminAuditSearchQuerySchema,
  adminJobRetrySchema,
  adminJobSearchQuerySchema,
  adminPlatformRoleUpdateSchema,
  domainIdSchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AdminService } from "./admin-service.js";
import type { ApiContext, ApiEnv, RequestActor } from "./http/index.js";
import {
  ApiHttpError,
  parseJsonBody,
  parseQuery,
  rateLimitedError,
  validationError,
} from "./http/index.js";

const DEFAULT_ADMIN_RATE_LIMIT = 60;
const DEFAULT_ADMIN_RATE_WINDOW_SECONDS = 60;

export interface AdminRateLimiter {
  consume(
    key: string,
  ):
    | { allowed: boolean; retryAfterSeconds: number }
    | Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface AdminRateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  now?: () => number;
}

/**
 * Process-local fallback for the MVP. The route accepts an injected limiter
 * so deployments with multiple API instances can provide a shared store
 * without changing the administrative HTTP contract.
 */
export class InMemoryAdminRateLimiter implements AdminRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  private readonly limit: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  constructor(options: AdminRateLimitOptions = {}) {
    this.limit = options.limit ?? DEFAULT_ADMIN_RATE_LIMIT;
    this.windowMilliseconds = (options.windowSeconds ?? DEFAULT_ADMIN_RATE_WINDOW_SECONDS) * 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError("Admin rate limit must be a positive integer");
    }
    if (!Number.isFinite(this.windowMilliseconds) || this.windowMilliseconds <= 0) {
      throw new RangeError("Admin rate-limit window must be positive");
    }
  }

  consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.windowMilliseconds) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      this.prune(now, key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count < this.limit) {
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.startedAt + this.windowMilliseconds - now) / 1_000),
      ),
    };
  }

  private prune(now: number, currentKey: string): void {
    for (const [key, bucket] of this.buckets) {
      if (key !== currentKey && now - bucket.startedAt >= this.windowMilliseconds) {
        this.buckets.delete(key);
      }
    }
  }
}

export interface AdminRoutesOptions {
  service: AdminService;
  actorMiddleware: MiddlewareHandler<ApiEnv>;
  rateLimit?: AdminRateLimiter | AdminRateLimitOptions;
}

export function configureAdminRoutes(router: Hono<ApiEnv>, options: AdminRoutesOptions): void {
  const { service } = options;
  const rateLimiter = isAdminRateLimiter(options.rateLimit)
    ? options.rateLimit
    : new InMemoryAdminRateLimiter(options.rateLimit);
  router.use("/admin/*", options.actorMiddleware);
  router.use("/admin/*", async (context, next) => {
    const result = await rateLimiter.consume(actorOf(context).userId);
    if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
    await next();
  });

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

  router.get("/admin/jobs", async (context) => {
    return context.json(
      await service.searchJobs(actorOf(context), parseQuery(context, adminJobSearchQuerySchema)),
    );
  });

  router.post("/admin/jobs/:jobId/retry", async (context) => {
    const parsedJobId = domainIdSchema.safeParse(context.req.param("jobId"));
    if (!parsedJobId.success) throw validationError(parsedJobId.error);
    const result = await service.retryJob(
      actorOf(context),
      parsedJobId.data,
      await parseJsonBody(context, adminJobRetrySchema),
      requiredIdempotencyKey(context),
      context.get("correlationId"),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.result);
  });

  router.get("/admin/audit", async (context) => {
    return context.json(
      await service.searchAudit(actorOf(context), parseQuery(context, adminAuditSearchQuerySchema)),
    );
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

function isAdminRateLimiter(
  value: AdminRateLimiter | AdminRateLimitOptions | undefined,
): value is AdminRateLimiter {
  return typeof value === "object" && value !== null && "consume" in value;
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
