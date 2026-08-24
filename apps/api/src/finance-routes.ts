import {
  closeStatementSchema,
  createCategorySchema,
  createCreditCardSchema,
  createInstallmentPlanSchema,
  createRecurrenceSchema,
  createTransactionSchema,
  domainIdSchema,
  paginationQuerySchema,
  payStatementSchema,
  reopenStatementSchema,
  statementListQuerySchema,
  transactionListQuerySchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import {
  FinanceConflictError,
  FinanceNotFoundError,
  FinancePermissionError,
  type FinanceScope,
  type FinanceService,
  VersionConflictError,
} from "./finance-service.js";
import {
  ApiHttpError,
  errorResponse,
  InvalidCursorError,
  notFoundError,
  validationError,
} from "./http/index.js";
import { parseJsonBody, parseQuery } from "./http/parsing.js";
import { requireIfMatch, setVersionHeaders } from "./http/preconditions.js";
import type { ApiEnv } from "./http/types.js";

export interface FinanceRoutesOptions {
  service: FinanceService;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** Mounts the financial vertical below /v1. The app composition supplies AUTH-004 actor/scope middleware. */
export function configureFinanceRoutes(router: Hono<ApiEnv>, options: FinanceRoutesOptions): void {
  const { service } = options;
  router.onError((error, context) => errorResponse(context, financeErrorToHttp(error)));
  for (const path of [
    "/workspaces/:workspaceId/transactions",
    "/workspaces/:workspaceId/transactions/*",
    "/workspaces/:workspaceId/categories",
    "/workspaces/:workspaceId/categories/*",
    "/workspaces/:workspaceId/cards",
    "/workspaces/:workspaceId/cards/*",
    "/workspaces/:workspaceId/statements",
    "/workspaces/:workspaceId/statements/*",
    "/workspaces/:workspaceId/recurrences",
    "/workspaces/:workspaceId/recurrences/*",
    "/workspaces/:workspaceId/installments",
    "/workspaces/:workspaceId/installments/*",
  ]) {
    router.use(path, options.scopeMiddleware);
  }

  router.post("/workspaces/:workspaceId/transactions", async (context) => {
    const input = await parseJsonBody(context, createTransactionSchema);
    const result = await service.createTransaction(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.transaction, result.replayed ? 200 : 201);
  });

  router.get("/workspaces/:workspaceId/transactions", async (context) => {
    const query = parseQuery(context, transactionListQuerySchema);
    const page = await service.listTransactions(scopeOf(context), query);
    return context.json({
      items: page.items,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    });
  });

  router.get("/workspaces/:workspaceId/transactions/:id", async (context) => {
    const id = parseDomainId(context.req.param("id"));
    const transaction = await service.getTransaction(scopeOf(context), id);
    if (!transaction) throw notFoundError();
    setVersionHeaders(context, transaction.version);
    return context.json(transaction);
  });

  router.get("/workspaces/:workspaceId/transactions/:id/audit", async (context) => {
    const transactionId = parseDomainId(context.req.param("id"));
    const query = parseQuery(context, paginationQuerySchema);
    const page = await service.listTransactionAudit(scopeOf(context), transactionId, query);
    return context.json({
      items: page.items,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    });
  });

  router.get("/workspaces/:workspaceId/transactions/:id/audit/:auditId", async (context) => {
    const transactionId = parseDomainId(context.req.param("id"));
    const auditId = parseDomainId(context.req.param("auditId"));
    const event = await service.getTransactionAudit(scopeOf(context), transactionId, auditId);
    return context.json(event);
  });

  router.get("/workspaces/:workspaceId/categories", async (context) => {
    const query = parseQuery(context, paginationQuerySchema);
    const items = await service.listCategories(scopeOf(context), query.limit);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.get("/workspaces/:workspaceId/cards", async (context) => {
    const query = parseQuery(context, paginationQuerySchema);
    const items = await service.listCards(scopeOf(context), query.limit);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.get("/workspaces/:workspaceId/statements", async (context) => {
    const query = parseQuery(context, statementListQuerySchema);
    const items = await service.listStatements(scopeOf(context), query.cardId, query.limit);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.get("/workspaces/:workspaceId/statements/:statementId/items", async (context) => {
    const statementId = parseDomainId(context.req.param("statementId"));
    const query = parseQuery(context, paginationQuerySchema);
    const page = await service.listStatementItems(scopeOf(context), statementId, query);
    return context.json({
      items: page.items,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    });
  });

  router.post("/workspaces/:workspaceId/transactions/:id/post", async (context) => {
    const id = parseDomainId(context.req.param("id"));
    const expectedVersion = requireIfMatch(context);
    const transaction = await service.postTransaction(
      scopeOf(context),
      id,
      requiredIdempotencyKey(context),
      expectedVersion,
    );
    setVersionHeaders(context, transaction.version);
    return context.json(transaction);
  });

  router.post("/workspaces/:workspaceId/transactions/:id/reverse", async (context) => {
    const id = parseDomainId(context.req.param("id"));
    const expectedVersion = requireIfMatch(context);
    const transaction = await service.reverseTransaction(
      scopeOf(context),
      id,
      requiredIdempotencyKey(context),
      expectedVersion,
    );
    setVersionHeaders(context, transaction.version);
    return context.json(transaction);
  });

  router.post("/workspaces/:workspaceId/categories", async (context) => {
    const input = await parseJsonBody(context, createCategorySchema);
    const result = await service.createCategory(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/cards", async (context) => {
    const input = await parseJsonBody(context, createCreditCardSchema);
    const result = await service.createCard(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/cards/:cardId/purchases", async (context) => {
    const cardId = parseDomainId(context.req.param("cardId"));
    const input = await parseJsonBody(context, createTransactionSchema.omit({ kind: true }));
    const result = await service.createCardPurchase(
      scopeOf(context),
      { ...input, cardId },
      requiredIdempotencyKey(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    return context.json(result.transaction, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/statements/:statementId/payments", async (context) => {
    const statementId = parseDomainId(context.req.param("statementId"));
    const input = await parseJsonBody(context, payStatementSchema);
    const result = await service.payStatement(
      scopeOf(context),
      statementId,
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/installments", async (context) => {
    const input = await parseJsonBody(context, createInstallmentPlanSchema);
    const result = await service.createInstallmentPlan(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/recurrences", async (context) => {
    const input = await parseJsonBody(context, createRecurrenceSchema);
    const result = await service.createRecurrence(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.post("/workspaces/:workspaceId/statements/:statementId/close", async (context) => {
    const statementId = parseDomainId(context.req.param("statementId"));
    const expectedVersion = requireIfMatch(context);
    await parseJsonBody(context, closeStatementSchema);
    const statement = await service.closeStatement(
      scopeOf(context),
      statementId,
      requiredIdempotencyKey(context),
      expectedVersion,
    );
    setVersionHeaders(context, statement.version);
    return context.json(statement);
  });

  router.post("/workspaces/:workspaceId/statements/:statementId/reopen", async (context) => {
    const statementId = parseDomainId(context.req.param("statementId"));
    const expectedVersion = requireIfMatch(context);
    await parseJsonBody(context, reopenStatementSchema);
    const statement = await service.reopenStatement(
      scopeOf(context),
      statementId,
      requiredIdempotencyKey(context),
      expectedVersion,
    );
    setVersionHeaders(context, statement.version);
    return context.json(statement);
  });
}

function scopeOf(context: Parameters<MiddlewareHandler<ApiEnv>>[0]): FinanceScope {
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

function requiredIdempotencyKey(context: Parameters<MiddlewareHandler<ApiEnv>>[0]): string {
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

export function financeErrorToHttp(error: unknown): unknown {
  if (error instanceof FinanceNotFoundError) return notFoundError();
  if (error instanceof FinancePermissionError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof VersionConflictError)
    return new ApiHttpError(412, "version_conflict", { currentVersion: error.currentVersion });
  if (error instanceof FinanceConflictError)
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  if (error instanceof InvalidCursorError)
    return new ApiHttpError(422, "validation_failed", {
      fieldErrors: { cursor: ["O cursor da lista não é válido."] },
    });
  return error;
}
