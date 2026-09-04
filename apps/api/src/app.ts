import { getDatabasePool, type Pool } from "@casei/database";
import { createS3ObjectStorageFromEnvironment, type StorageEnvironment } from "@casei/storage";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { BetterAuthAdminAuthPort } from "./admin-auth-port.js";
import {
  type AdminRateLimiter,
  type AdminRateLimitOptions,
  configureAdminRoutes,
} from "./admin-routes.js";
import { type AdminAccountStore, type AdminAuthPort, AdminService } from "./admin-service.js";
import { PostgresAdminAccountStore, PostgresAdminRateLimiter } from "./admin-store.js";
import {
  auth,
  defaultAuthOrigins,
  isAllowedAuthOrigin,
  validateAuthCallbackRequest,
} from "./auth.js";
import {
  configureDataExchangeRoutes,
  type DataExchangeExportApplication,
  dataExchangeErrorToHttp,
  type ImportUploadApplication,
} from "./data-exchange-routes.js";
import {
  ExportApplication,
  PostgresExportJobStore,
  PostgresExportSource,
} from "./export-service.js";
import { configureFinanceRoutes, financeErrorToHttp } from "./finance-routes.js";
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
import { configureImportRoutes, importErrorToHttp } from "./import-routes.js";
import type { ImportApplication } from "./import-service.js";
import { InsightService } from "./insight-service.js";
import { configureStockRoutes, stockErrorToHttp } from "./stock-routes.js";
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
  dataExchange?: DataExchangeAppOptions;
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
    twoFactorEnabled?: boolean;
    platformRole?: "platform_admin" | "platform_support" | null;
    stepUpToken?: string;
    ipAddress?: string | null;
    endpoint?: string | null;
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
  rateLimit?: AdminRateLimiter | AdminRateLimitOptions;
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
  upload?: ImportUploadApplication;
}

export interface DataExchangeAppOptions {
  exports?: DataExchangeExportApplication;
}

/**
 * Builds the default export application when the deployment has configured
 * object storage. Tests and alternate deployments can continue to inject the
 * application through `dataExchange.exports`.
 */
export function createDefaultExportApplication(input: {
  pool: Pool;
  applicationRole?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): DataExchangeExportApplication | undefined {
  const env = input.env ?? process.env;
  if (!env.CASEI_OBJECT_STORAGE_BUCKET?.trim()) return undefined;
  const applicationRole = input.applicationRole ?? env.DATABASE_ROLE ?? "casei_app";
  const environment = storageEnvironment(env.NODE_ENV);
  return new ExportApplication(
    new PostgresExportJobStore(input.pool, applicationRole),
    new PostgresExportSource(input.pool, applicationRole),
    createS3ObjectStorageFromEnvironment(env),
    { environment },
  );
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
      allowHeaders: [
        "Content-Type",
        "X-Correlation-ID",
        "Idempotency-Key",
        "If-Match",
        "X-Admin-Step-Up",
      ],
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
  const adminRateLimiter = options.admin
    ? (options.admin.rateLimit ??
      (options.admin.pool
        ? new PostgresAdminRateLimiter(options.admin.pool, options.admin.applicationRole)
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
      upload: options.import.upload,
      scopeMiddleware: async (context, next) => {
        if (!actorMiddleware || !scopeMiddleware)
          throw new Error("Import auth boundary is unavailable");
        await actorMiddleware(context, async () => {
          await scopeMiddleware(context, next);
        });
      },
    });
  }
  if (identityService && actorMiddleware && scopeMiddleware) {
    const dataScopeMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
      await actorMiddleware(context, async () => {
        await scopeMiddleware(context, next);
      });
    };
    configureDataExchangeRoutes(v1, {
      exports: options.dataExchange?.exports,
      importUnavailable: !options.import,
      scopeMiddleware: dataScopeMiddleware,
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
  v1.onError((error, context) => errorResponse(context, apiErrorToHttp(error, context.req.path)));
  if (options.admin) {
    if (!identityService || !actorMiddleware) {
      throw new Error("Admin auth boundary is unavailable");
    }
    if (!adminService) throw new Error("Admin service is unavailable");
    configureAdminRoutes(v1, {
      service: adminService,
      actorMiddleware,
      rateLimit: adminRateLimiter,
    });
  }
  app.route("/v1", v1);

  return app;
}

function apiErrorToHttp(error: unknown, path: string): unknown {
  const mappers = path.includes("/data/imports")
    ? [importErrorToHttp, dataExchangeErrorToHttp]
    : path.includes("/data/")
      ? [dataExchangeErrorToHttp]
      : path.includes("/stock/")
        ? [stockErrorToHttp]
        : isFinancePath(path)
          ? [financeErrorToHttp]
          : [];
  for (const mapper of mappers) {
    const mapped = mapper(error);
    if (mapped !== error) return mapped;
  }
  return error;
}

function isFinancePath(path: string): boolean {
  return [
    "/transactions",
    "/wallet",
    "/loans",
    "/categories",
    "/cards",
    "/statements",
    "/recurrences",
    "/installments",
    "/goals",
    "/insights",
  ].some((segment) => path.includes(segment));
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
    stepUpToken: context.req.header("X-Admin-Step-Up") ?? undefined,
    ipAddress: session.session.ipAddress ?? null,
    endpoint: new URL(context.req.url).pathname,
    recentAuthentication: Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1_000,
    twoFactorEnabled: session.user.twoFactorEnabled === true,
    platformRole: platformAccess?.role ?? null,
  };
}

const appPool = getDatabasePool();
const defaultExportApplication = createDefaultExportApplication({ pool: appPool });
export const app = createApp(undefined, {
  identity: { pool: appPool },
  admin: { pool: appPool },
  finance: { pool: appPool },
  stock: { pool: appPool },
  ...(defaultExportApplication ? { dataExchange: { exports: defaultExportApplication } } : {}),
});

function storageEnvironment(value: string | undefined): StorageEnvironment {
  if (value === "production") return "prod";
  if (value === "test") return "test";
  if (value === "staging") return "staging";
  return "dev";
}
