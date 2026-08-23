import type { Pool } from "@casei/database";
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
import { type ApiEnv, correlationMiddleware, errorResponse, notFoundError } from "./http/index.js";

export type V1Configurator = (router: Hono<ApiEnv>) => void;
export interface AppOptions {
  authHandler?: (request: Request) => Response | Promise<Response>;
  authOrigins?: string[];
  finance?: FinanceAppOptions;
}

export interface FinanceAppOptions {
  pool: Pool;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
  /** PostgreSQL role used by every finance command and query. */
  applicationRole?: string;
  /** Secret used to sign private finance list cursors. */
  cursorSecret?: string;
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
  if (options.finance) {
    configureFinanceRoutes(v1, {
      service: new FinanceService(options.finance.pool, {
        applicationRole: options.finance.applicationRole,
        cursorSecret: options.finance.cursorSecret,
      }),
      scopeMiddleware: options.finance.scopeMiddleware,
    });
  }
  app.route("/v1", v1);

  return app;
}

export const app = createApp();
