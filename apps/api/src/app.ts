import { Hono } from "hono";

export const app = new Hono().get("/health", (context) =>
  context.json({ service: "casei-api", status: "ok" }),
);
