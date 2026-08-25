import { getDatabasePool, type Pool } from "@casei/database";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { BetterAuthAdminAuthPort } from "./admin-auth-port.js";
import { configureAdminRoutes } from "./admin-routes.js";
import { type AdminAccountStore, type AdminAuthPort, AdminService } from "./admin-service.js";
import { PostgresAdminAccountStore } from "./admin-store.js";
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
import type { RequestActor } from "./http/types.js";
import { configureIdentityRoutes } from "./identity-routes.js";
import { IdentityService } from "./identity-service.js";
import { configureImportRoutes } from "./import-routes.js";
import type { ImportApplication } from "./import-service.js";
import { InsightService } from "./insight-service.js";
import { configureStockRoutes } from "./stock-routes.js";
import { StockService } from "./stock-service.js";

export type V1Configurator = (router: Hono<ApiEnv>) => void;
export interface AppOptions {
  authHandler?: (request: Request) => Response | Promise<Response>;
  authOrigins?: string[];
  finance?: FinanceAppOptions;
  stock?: StockAppOptions;
  identity?: IdentityAppOptions;
  admin?: AdminAppOptions;
  import?: ImportAppOptions;
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
    platformRole?: "platform_admin" | "platform_support" | null;
  } | null>;
}

export interface AdminAppOptions {
  /** Injectable service boundary for HTTP contract tests; production wires the pool adapter. */
  service?: AdminService;
  pool?: Pool;
  store?: AdminAccountStore;
  authPort?: AdminAuthPort;
  applicationRole?: string;
  webOrigin?: string;
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
  /** Injectable read model boundary; production uses the finance pool. */
  insightService?: InsightService;
}

export interface StockAppOptions {
  pool: Pool;
  service?: StockService;
  applicationRole?: string;
}

export interface ImportAppOptions {
  application: ImportApplication;
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

  const identityPool =
    options.identity?.pool ?? options.finance?.pool ?? options.stock?.pool ?? options.admin?.pool;
  const identityService =
    options.identity?.service ??
    (identityPool
      ? new IdentityService(identityPool, {
          applicationRole:
            options.identity?.applicationRole ??
            options.finance?.applicationRole ??
            options.admin?.applicationRole,
          webOrigin: options.identity?.webOrigin,
        })
      : undefined);
  const adminStore = options.admin
    ? (options.admin.store ??
      (options.admin.pool
        ? new PostgresAdminAccountStore(options.admin.pool, options.admin.applicationRole)
        : undefined))
    : undefined;
  const actorResolver =
    options.identity?.actorResolver ??
    ((context: Parameters<MiddlewareHandler<ApiEnv>>[0]) =>
      defaultActorResolver(context, adminStore));
  const adminService = options.admin
    ? (options.admin.service ??
      (adminStore
        ? new AdminService(
            adminStore,
            options.admin.authPort ??
              new BetterAuthAdminAuthPort(
                authHandler,
                process.env.BETTER_AUTH_URL ??
                  process.env.CASEI_API_ORIGIN ??
                  "http://localhost:3001",
                options.admin.webOrigin ?? process.env.CASEI_WEB_ORIGIN ?? "http://localhost:3000",
              ),
          )
        : undefined))
    : undefined;
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
      insightService:
        options.finance.insightService ??
        new InsightService(options.finance.pool, {
          applicationRole: options.finance.applicationRole,
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
  if (options.import) {
    configureImportRoutes(v1, {
      application: options.import.application,
      scopeMiddleware: async (context, next) => {
        if (!actorMiddleware || !scopeMiddleware)
          throw new Error("Import auth boundary is unavailable");
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
  if (options.admin) {
    if (!identityService || !actorMiddleware) {
      throw new Error("Admin auth boundary is unavailable");
    }
    if (!adminService) throw new Error("Admin service is unavailable");
    configureAdminRoutes(v1, { service: adminService, actorMiddleware });
  }
  app.route("/v1", v1);

  return app;
}

async function defaultActorResolver(
  context: Parameters<MiddlewareHandler<ApiEnv>>[0],
  adminStore?: AdminAccountStore,
): Promise<RequestActor | null> {
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return null;
  const platformAccess = await adminStore?.resolvePlatformActor?.(session.user.id);
  if (platformAccess?.suspended) return null;
  const createdAt = new Date(session.session.createdAt).getTime();
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.name,
    recentAuthentication: Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1_000,
    platformRole: platformAccess?.role ?? null,
  };
}

const appPool = getDatabasePool();
export const app = createApp(undefined, {
  identity: { pool: appPool },
  admin: { pool: appPool },
  finance: { pool: appPool },
  stock: { pool: appPool },
});
