import { Hono } from "hono";

import { type ApiEnv, correlationMiddleware, errorResponse, notFoundError } from "./http/index.js";

export type V1Configurator = (router: Hono<ApiEnv>) => void;

export function createApp(configureV1?: V1Configurator): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const v1 = new Hono<ApiEnv>();

  app.use("*", correlationMiddleware());
  app.onError((error, context) => errorResponse(context, error));
  app.notFound((context) => errorResponse(context, notFoundError()));

  app.get("/health", (context) => context.json({ service: "casei-api", status: "ok" }));
  configureV1?.(v1);
  app.route("/v1", v1);

  return app;
}

export const app = createApp();
