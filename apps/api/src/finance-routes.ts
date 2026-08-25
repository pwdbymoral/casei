import {
  categoryTransitionSchema,
  closeStatementSchema,
  createCategorySchema,
  createCreditCardSchema,
  createGoalSchema,
  createInstallmentPlanSchema,
  createLoanSchema,
  createRecurrenceSchema,
  createTransactionSchema,
  domainIdSchema,
  goalAllocateSchema,
  goalReleaseSchema,
  goalSpendSchema,
  goalTransitionSchema,
  insightWindowQuerySchema,
  loanPaymentSchema,
  paginationQuerySchema,
  payStatementSchema,
  recurrenceTransitionSchema,
  reopenStatementSchema,
  safeToSpendQuerySchema,
  settleTransactionSchema,
  statementListQuerySchema,
  transactionListQuerySchema,
  updateCategorySchema,
  updateCreditCardSchema,
  updateGoalSchema,
  updateTransactionSchema,
} from "@casei/contracts";
import { IdempotencyConflictError } from "@casei/database";
import { DomainError } from "@casei/domain";
import type { Hono, MiddlewareHandler } from "hono";
import {
  FinanceConflictError,
  FinanceNotFoundError,
  FinancePermissionError,
  type FinanceScope,
  type FinanceService,
  VersionConflictError,
} from "./finance-service.js";
import type { GoalService } from "./goal-service.js";
import {
  ApiHttpError,
  errorResponse,
  InvalidCursorError,
  notFoundError,
  validationError,
} from "./http/index.js";
import { parseJsonBody, parseOptionalJsonBody, parseQuery } from "./http/parsing.js";
import { requireIfMatch, setVersionHeaders } from "./http/preconditions.js";
import type { ApiEnv } from "./http/types.js";
import type { InsightService } from "./insight-service.js";

export interface FinanceRoutesOptions {
  service: FinanceService;
  goalService?: GoalService;
  insightService?: InsightService;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** Mounts the financial vertical below /v1. The app composition supplies AUTH-004 actor/scope middleware. */
export function configureFinanceRoutes(router: Hono<ApiEnv>, options: FinanceRoutesOptions): void {
  const { service } = options;
  const { goalService } = options;
  const { insightService } = options;
  router.onError((error, context) => errorResponse(context, financeErrorToHttp(error)));
  for (const path of [
    "/workspaces/:workspaceId/transactions",
    "/workspaces/:workspaceId/transactions/*",
    "/workspaces/:workspaceId/loans",
    "/workspaces/:workspaceId/loans/*",
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
    "/workspaces/:workspaceId/goals",
    "/workspaces/:workspaceId/goals/*",
    "/workspaces/:workspaceId/insights",
    "/workspaces/:workspaceId/insights/*",
  ]) {
    router.use(path, options.scopeMiddleware);
  }

  if (insightService) {
    router.get("/workspaces/:workspaceId/insights/financial", async (context) => {
      const query = parseQuery(context, insightWindowQuerySchema);
      const model = await insightService.getFinancialReadModel(scopeOf(context), query);
      return context.json(model);
    });

    router.get("/workspaces/:workspaceId/insights/safe-to-spend", async (context) => {
      const query = parseQuery(context, safeToSpendQuerySchema);
      const model = await insightService.getSafeToSpend(scopeOf(context), query);
      return context.json(model);
    });
  }

  if (goalService) {
    router.post("/workspaces/:workspaceId/goals", async (context) => {
      const input = await parseJsonBody(context, createGoalSchema);
      const result = await goalService.createGoal(
        scopeOf(context),
        input,
        requiredIdempotencyKey(context),
      );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      return context.json(result.goal, result.replayed ? 200 : 201);
    });

    router.get("/workspaces/:workspaceId/goals", async (context) => {
      const query = parseQuery(context, paginationQuerySchema);
      const page = await goalService.listGoals(scopeOf(context), query);
      return context.json({
        items: page.items,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
      });
    });

    router.get("/workspaces/:workspaceId/goals/:goalId", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const goal = await goalService.getGoal(scopeOf(context), goalId);
      if (!goal) throw notFoundError();
      setVersionHeaders(context, goal.version);
      return context.json(goal);
    });

    router.get("/workspaces/:workspaceId/goals/:goalId/movements", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const query = parseQuery(context, paginationQuerySchema);
      const page = await goalService.listMovements(scopeOf(context), goalId, query);
      return context.json({
        items: page.items,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
      });
    });

    router.patch("/workspaces/:workspaceId/goals/:goalId", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const input = await parseJsonBody(context, updateGoalSchema);
      const result = await goalService.updateGoal(
        scopeOf(context),
        goalId,
        input,
        requiredIdempotencyKey(context),
        requireIfMatch(context),
      );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      setVersionHeaders(context, result.goal.version);
      return context.json(result, 200);
    });

    router.post("/workspaces/:workspaceId/goals/:goalId/allocate", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const input = await parseJsonBody(context, goalAllocateSchema);
      const result = await goalService.allocateGoal(
        scopeOf(context),
        goalId,
        input,
        requiredIdempotencyKey(context),
        requireIfMatch(context),
      );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      setVersionHeaders(context, result.goal.version);
      return context.json(result, 200);
    });

    router.post("/workspaces/:workspaceId/goals/:goalId/release", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const input = await parseJsonBody(context, goalReleaseSchema);
      const result = await goalService.releaseGoal(
        scopeOf(context),
        goalId,
        input,
        requiredIdempotencyKey(context),
        requireIfMatch(context),
      );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      setVersionHeaders(context, result.goal.version);
      return context.json(result, 200);
    });

    router.post("/workspaces/:workspaceId/goals/:goalId/spend", async (context) => {
      const goalId = parseDomainId(context.req.param("goalId"));
      const input = await parseJsonBody(context, goalSpendSchema);
      const result = await goalService.spendGoal(
        scopeOf(context),
        goalId,
        input,
        requiredIdempotencyKey(context),
        requireIfMatch(context),
      );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      setVersionHeaders(context, result.goal.version);
      return context.json(result, result.replayed ? 200 : 201);
    });

    for (const action of ["pause", "resume", "complete", "cancel"] as const) {
      router.post(`/workspaces/:workspaceId/goals/:goalId/${action}`, async (context) => {
        const goalId = parseDomainId(context.req.param("goalId"));
        const input = await parseJsonBody(context, goalTransitionSchema);
        const result = await goalService.transitionGoal(
          scopeOf(context),
          goalId,
          action,
          input,
          requiredIdempotencyKey(context),
          requireIfMatch(context),
        );
        context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
        setVersionHeaders(context, result.goal.version);
        return context.json(result, 200);
      });
    }
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

  router.post("/workspaces/:workspaceId/loans", async (context) => {
    const input = await parseJsonBody(context, createLoanSchema);
    const result = await service.createLoan(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.loan.version);
    return context.json(result.loan, result.replayed ? 200 : 201);
  });

  router.get("/workspaces/:workspaceId/loans", async (context) => {
    const query = parseQuery(context, paginationQuerySchema);
    const items = await service.listLoans(scopeOf(context), query.limit);
    return context.json({ items, page: { nextCursor: null, hasMore: false } });
  });

  router.get("/workspaces/:workspaceId/loans/:loanId", async (context) => {
    const loanId = parseDomainId(context.req.param("loanId"));
    const loan = await service.getLoan(scopeOf(context), loanId);
    if (!loan) throw notFoundError();
    setVersionHeaders(context, loan.version);
    return context.json(loan);
  });

  router.get("/workspaces/:workspaceId/loans/:loanId/payments", async (context) => {
    const loanId = parseDomainId(context.req.param("loanId"));
    const query = parseQuery(context, paginationQuerySchema);
    const page = await service.listLoanPayments(scopeOf(context), loanId, query);
    return context.json({
      items: page.items,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    });
  });

  router.post("/workspaces/:workspaceId/loans/:loanId/payments", async (context) => {
    const loanId = parseDomainId(context.req.param("loanId"));
    const expectedVersion = requireIfMatch(context);
    const input = await parseJsonBody(context, loanPaymentSchema);
    const result = await service.payLoan(
      scopeOf(context),
      loanId,
      requiredIdempotencyKey(context),
      expectedVersion,
      input,
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.response.loan.version);
    return context.json(result.response);
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

  router.patch("/workspaces/:workspaceId/transactions/:id", async (context) => {
    const id = parseDomainId(context.req.param("id"));
    const input = await parseJsonBody(context, updateTransactionSchema);
    const result = await service.updateTransaction(
      scopeOf(context),
      id,
      input,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.transaction.version);
    return context.json(result.transaction);
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

  router.get("/workspaces/:workspaceId/statements/:statementId", async (context) => {
    const statementId = parseDomainId(context.req.param("statementId"));
    const statement = await service.getStatement(scopeOf(context), statementId);
    if (!statement) throw notFoundError();
    setVersionHeaders(context, statement.version);
    return context.json(statement);
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
    const input = await parseOptionalJsonBody(context, settleTransactionSchema);
    const transaction = await service.postTransaction(
      scopeOf(context),
      id,
      requiredIdempotencyKey(context),
      expectedVersion,
      input,
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

  router.patch("/workspaces/:workspaceId/categories/:categoryId", async (context) => {
    const categoryId = parseDomainId(context.req.param("categoryId"));
    const input = await parseJsonBody(context, updateCategorySchema);
    const result = await service.updateCategory(
      scopeOf(context),
      categoryId,
      input,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.category.version);
    return context.json(result.category);
  });

  for (const action of ["archive", "restore"] as const) {
    router.post(`/workspaces/:workspaceId/categories/:categoryId/${action}`, async (context) => {
      const categoryId = parseDomainId(context.req.param("categoryId"));
      await parseJsonBody(context, categoryTransitionSchema);
      const result =
        action === "archive"
          ? await service.archiveCategory(
              scopeOf(context),
              categoryId,
              requiredIdempotencyKey(context),
              requireIfMatch(context),
            )
          : await service.restoreCategory(
              scopeOf(context),
              categoryId,
              requiredIdempotencyKey(context),
              requireIfMatch(context),
            );
      context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
      setVersionHeaders(context, result.category.version);
      return context.json(result.category);
    });
  }

  router.post("/workspaces/:workspaceId/cards", async (context) => {
    const input = await parseJsonBody(context, createCreditCardSchema);
    const result = await service.createCard(
      scopeOf(context),
      input,
      requiredIdempotencyKey(context),
    );
    return context.json(result.response as Record<string, unknown>, result.replayed ? 200 : 201);
  });

  router.patch("/workspaces/:workspaceId/cards/:cardId", async (context) => {
    const cardId = parseDomainId(context.req.param("cardId"));
    const input = await parseJsonBody(context, updateCreditCardSchema);
    const result = await service.updateCard(
      scopeOf(context),
      cardId,
      input,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.card.version);
    return context.json(result.card);
  });

  router.post("/workspaces/:workspaceId/cards/:cardId/archive", async (context) => {
    const cardId = parseDomainId(context.req.param("cardId"));
    const result = await service.archiveCard(
      scopeOf(context),
      cardId,
      requiredIdempotencyKey(context),
      requireIfMatch(context),
    );
    context.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    setVersionHeaders(context, result.card.version);
    return context.json(result.card);
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
    return context.json(
      result.response as unknown as Record<string, unknown>,
      result.replayed ? 200 : 201,
    );
  });

  for (const action of ["pause", "resume"] as const) {
    router.post(`/workspaces/:workspaceId/recurrences/:recurrenceId/${action}`, async (context) => {
      const recurrenceId = parseDomainId(context.req.param("recurrenceId"));
      const expectedVersion = requireIfMatch(context);
      const input = await parseJsonBody(context, recurrenceTransitionSchema);
      const result = await service.transitionRecurrence(
        scopeOf(context),
        recurrenceId,
        action,
        input,
        requiredIdempotencyKey(context),
        expectedVersion,
      );
      setVersionHeaders(context, result.recurrence.version);
      return context.json(result.recurrence);
    });
  }

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
  if (error instanceof IdempotencyConflictError)
    return new ApiHttpError(409, "idempotency_conflict");
  if (error instanceof DomainError && error.code === "validation_failed") {
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  }
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
