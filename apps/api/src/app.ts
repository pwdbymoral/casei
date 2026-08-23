import type { Pool } from "@casei/database";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { configureFinanceRoutes } from "./finance-routes.js";
import { FinanceService } from "./finance-service.js";

import { type ApiEnv, correlationMiddleware, errorResponse, notFoundError } from "./http/index.js";

export type V1Configurator = (router: Hono<ApiEnv>) => void;

export interface FinanceAppOptions {
  pool: Pool;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

export function createApp(configureV1?: V1Configurator, finance?: FinanceAppOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const v1 = new Hono<ApiEnv>();

  app.use("*", correlationMiddleware());
  v1.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) => errorResponse(context, error));
  app.notFound((context) => errorResponse(context, notFoundError()));

  app.get("/health", (context) => context.json({ service: "casei-api", status: "ok" }));
  configureV1?.(v1);
  if (finance) {
    configureFinanceRoutes(v1, {
      service: new FinanceService(finance.pool),
      scopeMiddleware: finance.scopeMiddleware,
    });
  }
  app.route("/v1", v1);

  return app;
}

export const app = createApp();
