import {
  createStockMovementSchema,
  createStockProductSchema,
  domainIdSchema,
  markStockMissingSchema,
  paginationQuerySchema,
  stockProductListQuerySchema,
  updateStockProductSchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import { ApiHttpError, errorResponse, notFoundError, validationError } from "./http/index.js";
import { parseJsonBody, parseQuery } from "./http/parsing.js";
import { requireIfMatch, setVersionHeaders } from "./http/preconditions.js";
import type { ApiContext, ApiEnv } from "./http/types.js";
import type { StockScope, StockService } from "./stock-service.js";
import {
  StockConflictError,
  StockNotFoundError,
  StockPermissionError,
  StockVersionConflictError,
} from "./stock-service.js";

export interface StockRoutesOptions {
  service: StockService;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** Mounts the household stock vertical below /v1 using the authenticated workspace scope. */
export function configureStockRoutes(router: Hono<ApiEnv>, options: StockRoutesOptions): void {
  const { service } = options;
  router.onError((error, context) => errorResponse(context, stockErrorToHttp(error)));
  for (const path of [
    "/workspaces/:workspaceId/stock/products",
    "/workspaces/:workspaceId/stock/products/*",
  ]) {
    router.use(path, options.scopeMiddleware);
  }

  router.get("/workspaces/:workspaceId/stock/products", async (context) => {
    const query = parseQuery(context, stockProductListQuerySchema);
    const items = await service.listProducts(scopeOf(context), query);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.post("/workspaces/:workspaceId/stock/products", async (context) => {
    const input = await parseJsonBody(context, createStockProductSchema);
    const result = await service.createProduct(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.product, result.replayed ? 200 : 201);
  });

  router.get("/workspaces/:workspaceId/stock/products/:productId", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const product = await service.getProduct(scopeOf(context), productId);
    if (!product) throw notFoundError();
    setVersionHeaders(context, product.version);
    return context.json(product);
  });

  router.patch("/workspaces/:workspaceId/stock/products/:productId", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const input = await parseJsonBody(context, updateStockProductSchema);
    const product = await service.updateProduct(
      scopeOf(context),
      productId,
      input,
      requireIfMatch(context),
    );
    setVersionHeaders(context, product.version);
    return context.json(product);
  });

  router.post("/workspaces/:workspaceId/stock/products/:productId/archive", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const result = await service.setArchived(
      scopeOf(context),
      productId,
      true,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.product.version);
    return context.json(result.product, result.replayed ? 200 : 200);
  });

  router.post("/workspaces/:workspaceId/stock/products/:productId/restore", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const result = await service.setArchived(
      scopeOf(context),
      productId,
      false,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.product.version);
    return context.json(result.product);
  });

  router.get("/workspaces/:workspaceId/stock/products/:productId/movements", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const query = parseQuery(context, paginationQuerySchema);
    const items = await service.listMovements(scopeOf(context), productId, query.limit);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.post("/workspaces/:workspaceId/stock/products/:productId/movements", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const input = await parseJsonBody(context, createStockMovementSchema);
    const result = await service.createMovement(
      scopeOf(context),
      productId,
      input,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.product.version);
    return context.json(result, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/stock/products/:productId/missing", async (context) => {
    const productId = parseDomainId(context.req.param("productId"));
    const input = await parseJsonBody(context, markStockMissingSchema);
    const result = await service.markMissing(
      scopeOf(context),
      productId,
      input,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.product.version);
    return context.json(result.product);
  });
}

function scopeOf(context: ApiContext): StockScope {
  const scope = context.get("workspaceScope");
  const correlationId = context.get("correlationId");
  if (!scope || !correlationId) throw new ApiHttpError(401, "unauthenticated");
  return {
    workspaceId: scope.workspaceId,
    actorId: scope.actor.userId,
    role: scope.role,
    correlationId,
  };
}

function requiredIdempotencyKey(context: ApiContext): string {
  const value = context.req.header("Idempotency-Key");
  if (!value || !/^[\x21-\x7e]{16,128}$/.test(value)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { "Idempotency-Key": ["Informe uma chave ASCII de 16 a 128 caracteres."] },
    });
  }
  return value;
}

function parseDomainId(value: string | undefined): string {
  const parsed = domainIdSchema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

export function stockErrorToHttp(error: unknown): unknown {
  if (error instanceof StockNotFoundError) return notFoundError();
  if (error instanceof StockPermissionError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof StockVersionConflictError) {
    return new ApiHttpError(412, "version_conflict", { currentVersion: error.currentVersion });
  }
  if (error instanceof StockConflictError) {
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  }
  return error;
}
