import { randomBytes } from "node:crypto";

import { type CorrelationId, correlationIdSchema } from "@casei/contracts";
import type { MiddlewareHandler } from "hono";

import type { ApiEnv } from "./types.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createCorrelationId(now = Date.now()): CorrelationId {
  let timestamp = BigInt(Math.max(0, now));
  const timeChars = Array.from({ length: 10 }, () => {
    const character = ULID_ALPHABET[Number(timestamp & 31n)];
    timestamp >>= 5n;
    return character;
  }).reverse();

  let random = 0n;
  for (const byte of randomBytes(10)) {
    random = (random << 8n) | BigInt(byte);
  }
  const randomChars = Array.from({ length: 16 }, () => {
    const character = ULID_ALPHABET[Number(random & 31n)];
    random >>= 5n;
    return character;
  }).reverse();

  return [...timeChars, ...randomChars].join("") as CorrelationId;
}

export function trustedCorrelationId(value: string | undefined): CorrelationId {
  return correlationIdSchema.safeParse(value).success
    ? (value as CorrelationId)
    : createCorrelationId();
}

export function correlationMiddleware(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const correlationId = trustedCorrelationId(context.req.header("X-Correlation-ID"));
    context.set("correlationId", correlationId);
    context.header("X-Correlation-ID", correlationId);
    await next();
  };
}
