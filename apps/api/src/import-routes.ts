import {
  type ImportCreateRequest,
  type ImportJobResponse,
  importCreateRequestSchema,
  importLineListQuerySchema,
} from "@casei/contracts";
import { IdempotencyConflictError, IdempotencyInProgressError } from "@casei/database";
import { ObjectStorageError } from "@casei/storage";
import type { Hono, MiddlewareHandler } from "hono";
import {
  type ImportUploadApplication,
  ImportUploadError,
  parseMultipartImport,
} from "./data-exchange-routes.js";
import { ApiHttpError, notFoundError } from "./http/index.js";
import { parseJsonBody, parseQuery } from "./http/parsing.js";
import type { ApiContext, ApiEnv } from "./http/types.js";
import {
  type ImportApplication,
  ImportAuthorizationError,
  ImportConflictError,
  ImportFailure,
  type ImportLineResult,
} from "./import-service.js";

export interface ImportRoutesOptions {
  application: ImportApplication;
  upload?: ImportUploadApplication;
  scopeMiddleware: MiddlewareHandler<ApiEnv>;
}

/** API command/query boundary for DATA-004; worker execution is deliberately separate. */
export function configureImportRoutes(router: Hono<ApiEnv>, options: ImportRoutesOptions): void {
  for (const path of [
    "/workspaces/:workspaceId/data/imports",
    "/workspaces/:workspaceId/data/imports/*",
  ]) {
    router.use(path, options.scopeMiddleware);
  }

  router.post("/workspaces/:workspaceId/data/imports", async (context) => {
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
      const acceptedDuplicateLines = duplicateLinesFromText(
        multipart.fields.acceptedDuplicateLines,
      );
      request = await options.upload.confirm({
        ...multipart,
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        previewId,
        mode,
        duplicatePolicy,
        acceptedDuplicateLines,
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

  router.post("/workspaces/:workspaceId/data/imports/previews", async (context) => {
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
      ...(multipart.sheetName === undefined ? {} : { sheetName: multipart.sheetName }),
      ...(multipart.sheetIndex === undefined ? {} : { sheetIndex: multipart.sheetIndex }),
      mapping: multipart.mapping,
    });
    return context.json(preview);
  });

  router.get("/workspaces/:workspaceId/data/imports/:importId", async (context) => {
    const scope = scopeOf(context);
    const importId = context.req.param("importId");
    const job = await options.application.getJob(importId, scope.workspaceId);
    if (!job) throw notFoundError();
    const results = await options.application.listResults(
      importId,
      scope.workspaceId,
      undefined,
      100,
    );
    return context.json(toImportJobResponse(job, results.items));
  });

  router.get("/workspaces/:workspaceId/data/imports/:importId/lines", async (context) => {
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

  router.post("/workspaces/:workspaceId/data/imports/:importId/cancel", async (context) => {
    const scope = scopeOf(context);
    if (scope.role === "viewer") throw new ApiHttpError(403, "permission_denied");
    const idempotencyKey = requiredIdempotencyKey(context);
    const job = await options.application.cancel(
      context.req.param("importId"),
      scope.workspaceId,
      {
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        origin: "api",
      },
      idempotencyKey,
    );
    return context.json(toImportJobResponse(job), 202);
  });

  router.post("/workspaces/:workspaceId/data/imports/:importId/retry", async (context) => {
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
      context.req.header("Idempotency-Key") ?? undefined,
    );
    return context.json(toImportJobResponse(job), 202);
  });

  router.post("/workspaces/:workspaceId/data/imports/:importId/reverse", async (context) => {
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
export function toImportJobResponse(
  job: {
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
  },
  lineResults: readonly ImportLineResult[] = [],
): ImportJobResponse {
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
    errors: [
      ...lineResults
        .filter((line) => line.status === "rejected" || line.status === "skipped")
        .map((line) => ({
          rowNumber: line.lineNumber,
          message: line.errorMessage ?? line.errorCode ?? "A linha não foi aplicada.",
        })),
      ...(job.lastError ? [{ rowNumber: 0, message: job.lastError }] : []),
    ].slice(0, 100),
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

function duplicateLinesFromText(value: unknown): readonly number[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 256_000) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { acceptedDuplicateLines: ["A seleção de duplicatas é inválida."] },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { acceptedDuplicateLines: ["A seleção de duplicatas não é um JSON válido."] },
      cause,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 50_000 ||
    parsed.some((line) => !Number.isSafeInteger(line) || line < 2 || line > 50_001)
  ) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { acceptedDuplicateLines: ["A seleção de duplicatas é inválida."] },
    });
  }
  const lines = parsed as number[];
  if (new Set(lines).size !== lines.length) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { acceptedDuplicateLines: ["A seleção de duplicatas contém linhas repetidas."] },
    });
  }
  return lines;
}

export function importErrorToHttp(error: unknown): unknown {
  if (error instanceof IdempotencyConflictError) {
    return new ApiHttpError(409, "idempotency_conflict");
  }
  if (error instanceof IdempotencyInProgressError) {
    return new ApiHttpError(409, "idempotency_conflict", {
      message: "A operação equivalente ainda está em processamento; tente novamente.",
    });
  }
  if (error instanceof ImportUploadError) {
    if (error.code === "not_found") return new ApiHttpError(404, "not_found");
    if (error.code === "expired")
      return new ApiHttpError(410, "validation_failed", { message: error.message });
    if (error.code === "source_mismatch")
      return new ApiHttpError(409, "validation_failed", { message: error.message });
    if (error.code === "storage_unavailable")
      return new ApiHttpError(503, "internal_error", {
        message: "O armazenamento da importação está indisponível; tente novamente.",
      });
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  }
  if (error instanceof ObjectStorageError) {
    if (error.code === "object_not_found") return new ApiHttpError(404, "not_found");
    if (error.code === "object_expired")
      return new ApiHttpError(410, "validation_failed", { message: error.message });
    if (
      error.code === "invalid_object" ||
      error.code === "invalid_format" ||
      error.code === "scan_rejected"
    ) {
      return new ApiHttpError(422, "validation_failed", { message: error.message });
    }
    return new ApiHttpError(503, "internal_error", {
      message: "O armazenamento da importação está indisponível; tente novamente.",
    });
  }
  if (error instanceof ImportAuthorizationError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof ImportConflictError)
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  if (error instanceof ImportFailure)
    return new ApiHttpError(422, "validation_failed", { message: error.message });
  return error;
}
