import {
  type ImportCreateRequest,
  type ImportJobResponse,
  importCreateRequestSchema,
  importLineListQuerySchema,
} from "@casei/contracts";
import type { Hono, MiddlewareHandler } from "hono";
import {
  type ImportUploadApplication,
  ImportUploadError,
  parseMultipartImport,
} from "./data-exchange-routes.js";
import { ApiHttpError, errorResponse, notFoundError } from "./http/index.js";
import { parseJsonBody, parseQuery } from "./http/parsing.js";
import type { ApiContext, ApiEnv } from "./http/types.js";
import {
  type ImportApplication,
  ImportAuthorizationError,
  ImportConflictError,
  ImportFailure,
} from "./import-service.js";

export interface ImportRoutesOptions {
  application: ImportApplication;
  upload?: ImportUploadApplication;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** API command/query boundary for DATA-004; worker execution is deliberately separate. */
export function configureImportRoutes(router: Hono<ApiEnv>, options: ImportRoutesOptions): void {
  router.onError((error, context) => errorResponse(context, importErrorToHttp(error)));
  for (const path of ["/workspaces/:workspaceId/imports", "/workspaces/:workspaceId/imports/*"]) {
    router.use(path, options.scopeMiddleware);
  }

  router.post("/workspaces/:workspaceId/imports", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    const idempotencyKey = requiredIdempotencyKey(context);
    const contentType = context.req.header("content-type") ?? "";
    let request: ImportCreateRequest;
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      if (!options.upload) {
        throw new ApiHttpError(503, "internal_error", {
          message: "A fronte server-side de upload ainda não foi configurada.",
        });
      }
      const multipart = await parseMultipartImport(context);
      const previewId = textField(multipart.fields.previewId, "previewId");
      const mode = modeFromText(multipart.fields.applyMode);
      const duplicatePolicy = duplicatePolicyFromText(multipart.fields.duplicatePolicy);
      request = await options.upload.confirm({
        ...multipart,
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        previewId,
        mode,
        duplicatePolicy,
      });
    } else {
      request = await parseJsonBody(context, importCreateRequestSchema);
    }
    const job = await options.application.create({
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      correlationId: scope.correlationId,
      request,
      idempotencyKey,
    });
    return context.json(toImportJobResponse(job), 202);
  });

  router.post("/workspaces/:workspaceId/imports/previews", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    if (!options.upload) {
      throw new ApiHttpError(503, "internal_error", {
        message: "A fronte server-side de upload ainda não foi configurada.",
      });
    }
    const multipart = await parseMultipartImport(context);
    if (!multipart.domain || !multipart.locale) {
      throw new ApiHttpError(422, "validation_failed", {
        fieldErrors: {
          domain: ["O domínio e o locale são obrigatórios para gerar uma prévia."],
          locale: ["O domínio e o locale são obrigatórios para gerar uma prévia."],
        },
      });
    }
    const preview = await options.upload.preview({
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      correlationId: scope.correlationId,
      fileName: multipart.fileName,
      contentType: multipart.contentType,
      bytes: multipart.bytes,
      domain: multipart.domain,
      locale: multipart.locale,
      mapping: multipart.mapping,
    });
    return context.json(preview);
  });

  router.get("/workspaces/:workspaceId/imports/:importId", async (context) => {
    const scope = scopeOf(context);
    const importId = context.req.param("importId");
    const job = await options.application.getJob(importId, scope.workspaceId);
    if (!job) throw notFoundError();
    return context.json(toImportJobResponse(job));
  });

  router.get("/workspaces/:workspaceId/imports/:importId/lines", async (context) => {
    const scope = scopeOf(context);
    const query = parseQuery(context, importLineListQuerySchema);
    const page = await options.application.listResults(
      context.req.param("importId"),
      scope.workspaceId,
      query.afterLine,
      query.limit,
    );
    return context.json({
      items: page.items.map(({ reversalToken: _reversalToken, ...line }) => line),
      page: { nextAfterLine: page.nextAfterLine },
    });
  });

  router.post("/workspaces/:workspaceId/imports/:importId/cancel", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    requiredIdempotencyKey(context);
    const job = await options.application.cancel(context.req.param("importId"), scope.workspaceId, {
      actorId: scope.actorId,
      correlationId: scope.correlationId,
      origin: "api",
    });
    return context.json(toImportJobResponse(job), 202);
  });

  router.post("/workspaces/:workspaceId/imports/:importId/retry", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    requiredIdempotencyKey(context);
    const retry = options.application.retry;
    if (!retry) {
      throw new ApiHttpError(503, "internal_error", {
        message: "A repetição de importação ainda não foi configurada.",
      });
    }
    const job = await retry.call(
      options.application,
      context.req.param("importId"),
      scope.workspaceId,
      {
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        origin: "api",
      },
    );
    return context.json(toImportJobResponse(job), 202);
  });

  router.post("/workspaces/:workspaceId/imports/:importId/reverse", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    requiredIdempotencyKey(context);
    const job = await options.application.reverse(
      context.req.param("importId"),
      scope.workspaceId,
      {
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        origin: "api",
      },
    );
    return context.json(toImportJobResponse(job), 202);
  });
}

/** Stable UI DTO; internal actor/storage/manifest fields never cross this boundary. */
export function toImportJobResponse(job: {
  readonly id: string;
  readonly workspaceId: string;
  readonly state: string;
  readonly cursor: number;
  readonly totalRows: number;
  readonly appliedRows: number;
  readonly skippedRows: number;
  readonly rejectedRows: number;
  readonly createdAt?: string;
  readonly expiresAt: string;
  readonly lastError?: string;
}): ImportJobResponse {
  const terminal = ["succeeded", "reversed", "cancelled"].includes(job.state);
  const status =
    job.state === "queued"
      ? "queued"
      : job.state === "cancelled"
        ? "canceled"
        : job.state === "succeeded" || job.state === "reversed"
          ? job.rejectedRows > 0
            ? "partial"
            : "completed"
          : job.state === "failed"
            ? job.appliedRows > 0 || job.skippedRows > 0
              ? "partial"
              : "failed"
            : "processing";
  const progress = terminal
    ? 100
    : job.totalRows > 0
      ? Math.min(99, Math.round((job.cursor / job.totalRows) * 100))
      : 0;
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    status,
    progress,
    totalRows: job.totalRows,
    appliedRows: job.appliedRows,
    ignoredRows: job.skippedRows,
    rejectedRows: job.rejectedRows,
    errors: job.lastError ? [{ rowNumber: 0, message: job.lastError }] : [],
    createdAt: job.createdAt ?? job.expiresAt,
    expiresAt: job.expiresAt,
    ...(job.lastError ? { message: job.lastError } : {}),
  };
}

function scopeOf(context: ApiContext): {
  workspaceId: string;
  actorId: string;
  correlationId: string;
  role: "owner" | "member" | "viewer";
} {
  const scope = context.get("workspaceScope");
  const correlationId = context.get("correlationId");
  const actor = context.get("actor");
  if (!scope || !correlationId || !actor) throw new ApiHttpError(401, "unauthenticated");
  return {
    workspaceId: scope.workspaceId,
    actorId: actor.userId,
    correlationId,
    role: scope.role,
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

function textField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 255) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { [name]: ["O campo é obrigatório."] },
    });
  }
  return value;
}

function modeFromText(value: unknown): "valid_only" | "all_or_nothing" {
  if (value === "valid_only" || value === "all_or_nothing") return value;
  throw new ApiHttpError(422, "validation_failed", {
    fieldErrors: { applyMode: ["O modo da importação é inválido."] },
  });
}

function duplicatePolicyFromText(value: unknown): "skip" | "import" | "review" {
  if (value === "ignore") return "skip";
  if (value === "import" || value === "review") return value;
  throw new ApiHttpError(422, "validation_failed", {
    fieldErrors: { duplicatePolicy: ["A política de duplicatas é inválida."] },
  });
}

export function importErrorToHttp(error: unknown): unknown {
  if (error instanceof ImportUploadError) {
    if (error.code === "not_found") return new ApiHttpError(404, "not_found");
    if (error.code === "expired")
      return new ApiHttpError(410, "validation_failed", { message: error.message });
    if (error.code === "source_mismatch")
      return new ApiHttpError(409, "validation_failed", { message: error.message });
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  }
  if (error instanceof ImportAuthorizationError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof ImportConflictError)
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  if (error instanceof ImportFailure)
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  return error;
}
