import type { ErrorCode } from "@casei/contracts";
import { correlationIdSchema } from "@casei/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { createCorrelationId } from "./correlation.js";
import { InvalidCursorError } from "./cursor.js";
import type { ApiContext } from "./types.js";

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  malformed_request: "A requisição não pôde ser lida.",
  validation_failed: "Revise os campos indicados.",
  unauthenticated: "Autentique-se para continuar.",
  not_found: "Recurso não encontrado.",
  permission_denied: "Você não tem permissão para esta ação.",
  precondition_required: "A requisição precisa informar a versão atual.",
  version_conflict: "O recurso foi alterado. Revise e tente novamente.",
  idempotency_conflict: "A chave de idempotência já foi usada com outro conteúdo.",
  rate_limited: "Muitas tentativas. Tente novamente mais tarde.",
  offline_required: "Esta ação precisa de conexão.",
  job_not_ready: "A operação ainda está sendo processada.",
  internal_error: "Ocorreu um erro inesperado. Tente novamente.",
};

export type FieldErrors = Record<string, string[]>;

export class ApiHttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly fieldErrors?: FieldErrors;
  readonly currentVersion?: number;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    options: {
      message?: string;
      fieldErrors?: FieldErrors;
      currentVersion?: number;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.currentVersion = options.currentVersion;
  }
}

export function validationError(error: z.ZodError): ApiHttpError {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_root";
    const messages = fieldErrors[path] ?? [];
    messages.push(issue.message);
    fieldErrors[path] = messages;
  }

  return new ApiHttpError(422, "validation_failed", { fieldErrors });
}

export function notFoundError(): ApiHttpError {
  return new ApiHttpError(404, "not_found");
}

export function unauthenticatedError(): ApiHttpError {
  return new ApiHttpError(401, "unauthenticated");
}

export function permissionDeniedError(): ApiHttpError {
  return new ApiHttpError(403, "permission_denied");
}

export function errorResponse(context: ApiContext, error: unknown): Response {
  const correlationId = getCorrelationId(context);
  const normalized = normalizeError(error);
  const body = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.fieldErrors ? { fieldErrors: normalized.fieldErrors } : {}),
      correlationId,
      ...(normalized.currentVersion === undefined
        ? {}
        : { currentVersion: normalized.currentVersion }),
    },
  };

  context.header("X-Correlation-ID", correlationId);
  context.header("Cache-Control", "no-store");
  return context.json(body, normalized.status);
}

export function getCorrelationId(context: ApiContext) {
  const value = context.get("correlationId");
  return correlationIdSchema.safeParse(value).success ? value : createCorrelationId();
}

function normalizeError(error: unknown): {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
  currentVersion?: number;
} {
  if (error instanceof ApiHttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
      currentVersion: error.currentVersion,
    };
  }

  if (error instanceof z.ZodError) {
    const validation = validationError(error);
    return {
      status: validation.status,
      code: validation.code,
      message: validation.message,
      fieldErrors: validation.fieldErrors,
    };
  }

  if (error instanceof InvalidCursorError) {
    return {
      status: 400,
      code: "malformed_request",
      message: "O cursor informado é inválido.",
    };
  }

  return { status: 500, code: "internal_error", message: DEFAULT_MESSAGES.internal_error };
}
