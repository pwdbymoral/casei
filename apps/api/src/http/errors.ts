import type { ErrorCode } from "@casei/contracts";
import { correlationIdSchema } from "@casei/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { createCorrelationId } from "./correlation.js";
import { InvalidCursorError } from "./cursor.js";
import type { ApiContext } from "./types.js";

export const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  malformed_request: "A requisição não pôde ser lida.",
  validation_failed: "Revise os campos indicados.",
  unauthenticated: "Autentique-se para continuar.",
  step_up_required: "Confirme o segundo fator para continuar.",
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
  readonly retryAfterSeconds?: number;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    options: {
      message?: string;
      fieldErrors?: FieldErrors;
      currentVersion?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.currentVersion = options.currentVersion;
    this.retryAfterSeconds =
      code === "rate_limited"
        ? normalizeRetryAfter(options.retryAfterSeconds)
        : options.retryAfterSeconds;
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

export function rateLimitedError(
  retryAfterSeconds = DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS,
): ApiHttpError {
  return new ApiHttpError(429, "rate_limited", { retryAfterSeconds });
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
  if (normalized.retryAfterSeconds !== undefined) {
    context.header("Retry-After", String(normalized.retryAfterSeconds));
  }
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
  retryAfterSeconds?: number;
} {
  if (error instanceof ApiHttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
      currentVersion: error.currentVersion,
      retryAfterSeconds: error.retryAfterSeconds,
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

  if (hasCode(error, "permission_denied")) {
    return { status: 403, code: "permission_denied", message: DEFAULT_MESSAGES.permission_denied };
  }
  if (hasCode(error, "not_found")) {
    return { status: 404, code: "not_found", message: DEFAULT_MESSAGES.not_found };
  }
  if (hasCode(error, "recent_auth_required")) {
    return {
      status: 401,
      code: "unauthenticated",
      message: "Confirme sua identidade novamente para continuar.",
    };
  }
  if (hasCode(error, "step_up_required")) {
    return {
      status: 401,
      code: "step_up_required",
      message: "Confirme o segundo fator para continuar.",
    };
  }
  if (hasCode(error, "rate_limited")) {
    return {
      status: 429,
      code: "rate_limited",
      message: error instanceof Error ? error.message : DEFAULT_MESSAGES.rate_limited,
      retryAfterSeconds:
        typeof error === "object" && error !== null && "retryAfterSeconds" in error
          ? Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds)
          : undefined,
    };
  }
  if (hasCode(error, "version_conflict")) {
    return {
      status: 412,
      code: "version_conflict",
      message: error instanceof Error ? error.message : DEFAULT_MESSAGES.version_conflict,
      currentVersion:
        typeof error === "object" && error !== null && "currentVersion" in error
          ? Number((error as { currentVersion?: unknown }).currentVersion)
          : undefined,
    };
  }
  if (hasCode(error, "last_platform_admin")) {
    return {
      status: 409,
      code: "validation_failed",
      message: "O último administrador ativo não pode ser removido ou suspenso.",
    };
  }
  if (hasCode(error, "idempotency_conflict")) {
    return {
      status: 409,
      code: "idempotency_conflict",
      message: DEFAULT_MESSAGES.idempotency_conflict,
    };
  }
  if (hasCode(error, "conflict")) {
    return {
      status: 409,
      code: "validation_failed",
      message: error instanceof Error ? error.message : DEFAULT_MESSAGES.validation_failed,
    };
  }

  return { status: 500, code: "internal_error", message: DEFAULT_MESSAGES.internal_error };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function normalizeRetryAfter(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS;
}
