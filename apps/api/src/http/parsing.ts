import { type PaginationQuery, paginationQuerySchema } from "@casei/contracts";
import type { Context } from "hono";
import type { z } from "zod";

import { ApiHttpError, validationError } from "./errors.js";
import { assertWorkspaceIdMatch } from "./middleware.js";
import type { ApiEnv } from "./types.js";

export async function parseJsonBody<TSchema extends z.ZodType>(
  context: Context<ApiEnv>,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch (cause) {
    throw new ApiHttpError(400, "malformed_request", { cause });
  }

  // Check the route-owned scope before Zod object parsing can strip unknown keys.
  assertWorkspaceIdMatch(context, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }
  return parsed.data;
}

/** Parses a JSON body when present; an omitted body is the schema's empty object. */
export async function parseOptionalJsonBody<TSchema extends z.ZodType>(
  context: Context<ApiEnv>,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  if (!context.req.header("content-type")) {
    const parsed = schema.safeParse({});
    if (!parsed.success) throw validationError(parsed.error);
    return parsed.data;
  }
  return parseJsonBody(context, schema);
}

export function parseQuery<TSchema extends z.ZodType>(
  context: Context<ApiEnv>,
  schema: TSchema,
): z.output<TSchema> {
  const parsed = schema.safeParse(Object.fromEntries(new URL(context.req.url).searchParams));
  if (!parsed.success) {
    throw validationError(parsed.error);
  }
  return parsed.data;
}

export function parseListQuery(
  searchParams: URLSearchParams,
): { data: PaginationQuery; error?: never } | { data?: never; error: z.ZodError } {
  const parsed = paginationQuerySchema.safeParse(Object.fromEntries(searchParams));
  return parsed.success ? { data: parsed.data } : { error: parsed.error };
}
