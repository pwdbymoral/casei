import { getDatabasePool, type Pool } from "@casei/database";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  auth,
  defaultAuthOrigins,
  isAllowedAuthOrigin,
  validateAuthCallbackRequest,
} from "./auth.js";
import { configureFinanceRoutes } from "./finance-routes.js";
import { FinanceService } from "./finance-service.js";
import { GoalService } from "./goal-service.js";
import {
  type ApiEnv,
  correlationMiddleware,
  createActorMiddleware,
  createWorkspaceScopeMiddleware,
  errorResponse,
  notFoundError,
} from "./http/index.js";
import { configureIdentityRoutes } from "./identity-routes.js";
import { IdentityService } from "./identity-service.js";
import { configureStockRoutes } from "./stock-routes.js";
import { StockService } from "./stock-service.js";

export type V1Configurator = (router: Hono<ApiEnv>) => void;
export interface AppOptions {
  authHandler?: (request: Request) => Response | Promise<Response>;
  authOrigins?: string[];
  finance?: FinanceAppOptions;
  stock?: StockAppOptions;
  identity?: IdentityAppOptions;
}

export interface IdentityAppOptions {
  pool: Pool;
  /** Injectable service boundary for HTTP contract tests; production uses the pool-backed service. */
  service?: IdentityService;
  applicationRole?: string;
  webOrigin?: string;
  actorResolver?: (context: Parameters<MiddlewareHandler<ApiEnv>>[0]) => Promise<{
    userId: string;
    email?: string;
    displayName?: string;
    recentAuthentication?: boolean;
  } | null>;
}

export interface FinanceAppOptions {
  pool: Pool;
  /** Injectable service boundary for app-composition tests; production uses the pool-backed service. */
  service?: FinanceService;
  /** Injectable goal service boundary; production uses the finance pool. */
  goalService?: GoalService;
  /** PostgreSQL role used by every finance command and query. */
  applicationRole?: string;
  /** Secret used to sign private finance list cursors. */
  cursorSecret?: string;
}

export interface StockAppOptions {
  pool: Pool;
  service?: StockService;
  applicationRole?: string;
}

export function createApp(configureV1?: V1Configurator, options: AppOptions = {}): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const v1 = new Hono<ApiEnv>();
  const authOrigins = options.authOrigins ?? defaultAuthOrigins();
  const authHandler = options.authHandler ?? ((request: Request) => auth.handler(request));

  app.use("*", correlationMiddleware());
  app.use(
    "/api/auth/*",
    cors({
      origin: (origin) => (isAllowedAuthOrigin(origin, authOrigins) ? origin : undefined),
      allowHeaders: ["Content-Type", "X-Correlation-ID"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "/v1/*",
    cors({
      origin: (origin) => (isAllowedAuthOrigin(origin, authOrigins) ? origin : undefined),
      allowHeaders: ["Content-Type", "X-Correlation-ID", "Idempotency-Key", "If-Match"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.all("/api/auth/*", async (context) => {
    const invalidCallback = await validateAuthCallbackRequest(context.req.raw, authOrigins);
    if (invalidCallback) return invalidCallback;
    const response = await authHandler(context.req.raw);
    if (response.status !== 429 || response.headers.has("Retry-After")) return response;
    const headers = new Headers(response.headers);
    headers.set("Retry-After", "60");
    return new Response(response.body, { status: response.status, headers });
  });
  v1.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) => errorResponse(context, error));
  app.notFound((context) => errorResponse(context, notFoundError()));

  app.get("/health", (context) => context.json({ service: "casei-api", status: "ok" }));
  configureV1?.(v1);

  const identityPool = options.identity?.pool ?? options.finance?.pool ?? options.stock?.pool;
  const identityService =
    options.identity?.service ??
    (identityPool
      ? new IdentityService(identityPool, {
          applicationRole: options.identity?.applicationRole ?? options.finance?.applicationRole,
          webOrigin: options.identity?.webOrigin,
        })
      : undefined);
  const actorResolver = options.identity?.actorResolver ?? defaultActorResolver;
  const actorMiddleware = identityService ? createActorMiddleware(actorResolver) : undefined;
  const scopeMiddleware = identityService
    ? createWorkspaceScopeMiddleware(async ({ actor, workspaceId, context }) =>
        identityService.resolveScope(actor, workspaceId, context.get("correlationId")),
      )
    : undefined;

  if (options.finance) {
    configureFinanceRoutes(v1, {
      service:
        options.finance.service ??
        new FinanceService(options.finance.pool, {
          applicationRole: options.finance.applicationRole,
          cursorSecret: options.finance.cursorSecret,
        }),
      goalService:
        options.finance.goalService ??
        new GoalService(options.finance.pool, {
          applicationRole: options.finance.applicationRole,
          cursorSecret: options.finance.cursorSecret,
        }),
      scopeMiddleware: async (context, next) => {
        if (!actorMiddleware || !scopeMiddleware)
          throw new Error("Finance auth boundary is unavailable");
        await actorMiddleware(context, async () => {
          await scopeMiddleware(context, next);
        });
      },
    });
  }
  if (options.stock) {
    configureStockRoutes(v1, {
      service:
        options.stock.service ??
        new StockService(options.stock.pool, { applicationRole: options.stock.applicationRole }),
      scopeMiddleware: async (context, next) => {
        if (!actorMiddleware || !scopeMiddleware)
          throw new Error("Stock auth boundary is unavailable");
        await actorMiddleware(context, async () => {
          await scopeMiddleware(context, next);
        });
      },
    });
  }
  if (options.identity) {
    if (!identityService || !actorMiddleware || !scopeMiddleware) {
      throw new Error("Identity auth boundary is unavailable");
    }
    configureIdentityRoutes(v1, {
      service: identityService,
      actorMiddleware,
      scopeMiddleware,
    });
  }
  app.route("/v1", v1);

  return app;
}

async function defaultActorResolver(context: Parameters<MiddlewareHandler<ApiEnv>>[0]) {
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return null;
  const createdAt = new Date(session.session.createdAt).getTime();
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.name,
    recentAuthentication: Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1_000,
  };
}

const appPool = getDatabasePool();
export const app = createApp(undefined, {
  identity: { pool: appPool },
  finance: { pool: appPool },
  stock: { pool: appPool },
});
