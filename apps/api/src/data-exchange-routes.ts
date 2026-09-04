import {
  dataExchangeDomainSchema,
  dataExchangeLocaleSchema,
  type ExportCreateRequest,
  type ExportJobResponse,
  exportCreateRequestSchema,
  type ImportCreateRequest,
  type ImportDomain,
  type ImportPreviewResponse,
} from "@casei/contracts";
import { IdempotencyConflictError, IdempotencyInProgressError } from "@casei/database";
import { ObjectStorageError } from "@casei/storage";
import type { Hono, MiddlewareHandler } from "hono";
import {
  ExportAuthorizationError,
  ExportConflictError,
  ExportExpiredError,
  ExportFailure,
  ExportNotFoundError,
} from "./export-service.js";
import { ApiHttpError, validationError } from "./http/index.js";
import type { ApiContext, ApiEnv } from "./http/types.js";
import { ImportAuthorizationError, ImportConflictError, ImportFailure } from "./import-service.js";

const MAX_IMPORT_FILE_BYTES = 10_000_000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MULTIPART_BODY_BYTES = 10_000_000;
const MAX_MULTIPART_FIELD_BYTES = 256_000;
const multipartTextEncoder = new TextEncoder();

export type ImportUploadErrorCode =
  | "not_found"
  | "expired"
  | "source_mismatch"
  | "invalid_preview"
  | "invalid_file"
  | "storage_unavailable";

export class ImportUploadError extends Error {
  readonly code: ImportUploadErrorCode;

  constructor(message: string, code: ImportUploadErrorCode = "invalid_file") {
    super(message);
    this.name = "ImportUploadError";
    this.code = code;
  }
}

export type ImportUploadApplication = {
  preview(input: ImportUploadPreviewInput): Promise<ImportPreviewResponse>;
  /** Validates preview/source equality and returns the canonical DATA-004 request. */
  confirm(input: ImportUploadConfirmInput): Promise<ImportCreateRequest>;
};

export type ImportUploadPreviewInput = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly domain: Exclude<ImportDomain, "full">;
  readonly locale: "pt-BR" | "en-US";
  readonly mapping: Readonly<Record<string, string>>;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sheetName?: string;
  readonly sheetIndex?: number;
};

export type ImportUploadConfirmInput = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly mapping: Readonly<Record<string, string>>;
  readonly previewId: string;
  readonly mode: "valid_only" | "all_or_nothing";
  readonly duplicatePolicy: "skip" | "import" | "review";
  /** Lines the user explicitly selected after reviewing duplicate suggestions. */
  readonly acceptedDuplicateLines?: readonly number[];
};

export type DataExchangeExportApplication = {
  list(input: DataExchangeExportContext): Promise<readonly ExportJobResponse[]>;
  create(
    input: DataExchangeExportContext & {
      readonly request: ExportCreateRequest;
      readonly idempotencyKey: string;
    },
  ): Promise<ExportJobResponse>;
  get(input: DataExchangeExportContext & { readonly exportId: string }): Promise<ExportJobResponse>;
  download(
    input: DataExchangeExportContext & { readonly exportId: string },
  ): Promise<DataExchangeDownload>;
};

export type DataExchangeExportContext = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly role: "owner" | "member" | "viewer";
  readonly correlationId: string;
  readonly origin: "api";
};

export type DataExchangeDownload = {
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly fileName: string;
  readonly contentLength?: number;
};

export interface DataExchangeRoutesOptions {
  readonly scopeMiddleware: MiddlewareHandler<ApiEnv>;
  readonly exports?: DataExchangeExportApplication;
  readonly importUnavailable?: boolean;
}

/**
 * HTTP boundary for export jobs. The application port owns persistence,
 * authorization at generation/download time and object-storage expiry.
 */
export function configureDataExchangeRoutes(
  router: Hono<ApiEnv>,
  options: DataExchangeRoutesOptions,
): void {
  for (const path of [
    "/workspaces/:workspaceId/data/exports",
    "/workspaces/:workspaceId/data/exports/*",
  ]) {
    router.use(path, options.scopeMiddleware);
  }
  if (options.importUnavailable) {
    for (const path of [
      "/workspaces/:workspaceId/data/imports",
      "/workspaces/:workspaceId/data/imports/*",
    ]) {
      router.use(path, options.scopeMiddleware);
    }
    const unavailableImport = async () => {
      throw new ApiHttpError(503, "internal_error", {
        message: "A fronte server-side de importação ainda não foi configurada.",
      });
    };
    router.post("/workspaces/:workspaceId/data/imports", unavailableImport);
    router.all("/workspaces/:workspaceId/data/imports/*", unavailableImport);
  }

  router.get("/workspaces/:workspaceId/data/exports", async (context) => {
    const scope = scopeOf(context);
    const application = requireExportApplication(options.exports);
    return context.json(await application.list({ ...scope, origin: "api" }));
  });

  router.post("/workspaces/:workspaceId/data/exports", async (context) => {
    const scope = scopeOf(context);
    const application = requireExportApplication(options.exports);
    const idempotencyKey = requiredIdempotencyKey(context);
    const body = await parseExportBody(context);
    return context.json(
      await application.create({
        ...scope,
        origin: "api",
        request: body,
        idempotencyKey,
      }),
      202,
    );
  });

  router.get("/workspaces/:workspaceId/data/exports/:exportId", async (context) => {
    const scope = scopeOf(context);
    const application = requireExportApplication(options.exports);
    return context.json(
      await application.get({
        ...scope,
        origin: "api",
        exportId: context.req.param("exportId"),
      }),
    );
  });

  router.get("/workspaces/:workspaceId/data/exports/:exportId/download", async (context) => {
    const scope = scopeOf(context);
    const application = requireExportApplication(options.exports);
    const download = await application.download({
      ...scope,
      origin: "api",
      exportId: context.req.param("exportId"),
    });
    const headers = new Headers({
      "Content-Type": download.contentType,
      "Content-Disposition": contentDisposition(download.fileName),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (download.contentLength !== undefined)
      headers.set("Content-Length", String(download.contentLength));
    return new Response(download.body as BodyInit, { status: 200, headers });
  });
}

export function requireExportApplication(
  application: DataExchangeExportApplication | undefined,
): DataExchangeExportApplication {
  if (!application)
    throw new ApiHttpError(503, "internal_error", {
      message: "A fronte server-side de exportação ainda não foi configurada.",
    });
  return application;
}

export async function parseMultipartImport(context: ApiContext): Promise<{
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly domain?: Exclude<ImportDomain, "full">;
  readonly locale?: "pt-BR" | "en-US";
  readonly sheetName?: string;
  readonly sheetIndex?: number;
  readonly mapping: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string>>;
}> {
  const declaredLength = context.req.header("content-length");
  if (declaredLength === undefined) {
    throw new ApiHttpError(413, "validation_failed", {
      message: "O upload multipart precisa informar o tamanho do corpo antes do envio.",
    });
  }
  const normalizedLength = declaredLength.trim();
  const parsedLength = Number(normalizedLength);
  if (
    !/^\d+$/u.test(normalizedLength) ||
    !Number.isSafeInteger(parsedLength) ||
    parsedLength < 1 ||
    parsedLength > MAX_MULTIPART_BODY_BYTES
  ) {
    throw new ApiHttpError(413, "validation_failed", {
      message: "O corpo do upload excede o limite de 10 MB.",
    });
  }
  let body: Record<string, unknown>;
  try {
    body = await context.req.parseBody();
  } catch (cause) {
    throw new ApiHttpError(400, "malformed_request", { cause });
  }
  const file = body.file;
  if (!(file instanceof File) || Array.isArray(file)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { file: ["Envie um arquivo CSV ou XLSX."] },
    });
  }
  if (file.size < 1 || file.size > MAX_IMPORT_FILE_BYTES) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { file: ["O arquivo deve ter entre 1 byte e 10 MB."] },
    });
  }
  const fileName = file.name.trim();
  if (
    !fileName ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    [...fileName].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { file: ["O nome do arquivo é inválido."] },
    });
  }
  let domain: Exclude<ImportDomain, "full"> | undefined;
  if (body.domain !== undefined) {
    const parsedDomain = dataExchangeDomainSchema.safeParse(body.domain);
    if (!parsedDomain.success || parsedDomain.data === "complete") {
      throw new ApiHttpError(422, "validation_failed", {
        fieldErrors: { domain: ["O domínio da importação é inválido."] },
      });
    }
    domain = parsedDomain.data;
  }
  let locale: "pt-BR" | "en-US" | undefined;
  if (body.locale !== undefined) {
    const parsedLocale = dataExchangeLocaleSchema.safeParse(body.locale);
    if (!parsedLocale.success) {
      throw new ApiHttpError(422, "validation_failed", {
        fieldErrors: { locale: ["O locale da importação é inválido."] },
      });
    }
    locale = parsedLocale.data;
  }
  const mapping = parseMapping(body.mapping);
  const sheetName = optionalSheetName(body.sheetName);
  const sheetIndex = optionalSheetIndex(body.sheetIndex);
  if (sheetName !== undefined && sheetIndex !== undefined) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { sheetName: ["Informe o nome ou o índice da planilha, não ambos."] },
    });
  }
  const fields: Record<string, string> = {};
  let fieldsBytes = 0;
  let fileBytes = 0;
  for (const [key, value] of Object.entries(body)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item instanceof File) {
        fileBytes += item.size;
        continue;
      }
      if (typeof item !== "string") continue;
      fieldsBytes += multipartTextEncoder.encode(item).byteLength;
      if (fieldsBytes > MAX_MULTIPART_FIELD_BYTES || item.length > 100_000) {
        throw new ApiHttpError(413, "validation_failed", {
          message: "Os campos do upload excedem o limite permitido.",
        });
      }
      if (typeof value === "string") fields[key] = value;
    }
  }
  if (fileBytes + fieldsBytes > MAX_MULTIPART_BODY_BYTES) {
    throw new ApiHttpError(413, "validation_failed", {
      message: "O corpo do upload excede o limite de 10 MB.",
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { file: ["O arquivo excede o limite permitido."] },
    });
  }
  return {
    fileName,
    contentType: file.type || "application/octet-stream",
    bytes,
    domain,
    locale,
    ...(sheetName === undefined ? {} : { sheetName }),
    ...(sheetIndex === undefined ? {} : { sheetIndex }),
    mapping,
    fields,
  };
}

function optionalSheetName(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 255) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { sheetName: ["O nome da planilha é inválido."] },
    });
  }
  return value.trim();
}

function optionalSheetIndex(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { sheetIndex: ["O índice da planilha é inválido."] },
    });
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed > 255) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { sheetIndex: ["O índice da planilha é inválido."] },
    });
  }
  return parsed;
}

export function parseMapping(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string" || value.length > MAX_MULTIPART_FIELD_BYTES) throw invalidMapping();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { mapping: ["O mapeamento não é um JSON válido."] },
      cause,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidMapping();
  const mapping: Record<string, string> = {};
  const entries = Object.entries(parsed);
  if (entries.length > 256) throw invalidMapping();
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,99}$/u.test(key) || typeof item !== "string" || item.length > 1_000) {
      throw invalidMapping();
    }
    mapping[key] = item;
  }
  return mapping;
}

async function parseExportBody(context: ApiContext): Promise<ExportCreateRequest> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch (cause) {
    throw new ApiHttpError(400, "malformed_request", { cause });
  }
  const parsed = exportCreateRequestSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { to: ["A data final deve ser igual ou posterior à inicial."] },
    });
  }
  return parsed.data;
}

function invalidMapping(): never {
  throw new ApiHttpError(422, "validation_failed", {
    fieldErrors: { mapping: ["O mapeamento deve ser um objeto JSON de textos."] },
  });
}

function scopeOf(context: ApiContext): DataExchangeExportContext {
  const scope = context.get("workspaceScope");
  const correlationId = context.get("correlationId");
  const actor = context.get("actor");
  if (!scope || !correlationId || !actor) throw new ApiHttpError(401, "unauthenticated");
  return {
    workspaceId: scope.workspaceId,
    actorId: actor.userId,
    role: scope.role,
    correlationId,
  } as DataExchangeExportContext;
}

function requiredIdempotencyKey(context: ApiContext): string {
  const value = context.req.header("Idempotency-Key");
  if (!value || !/^[\x21-\x7e]{16,128}$/u.test(value)) {
    throw new ApiHttpError(422, "validation_failed", {
      fieldErrors: { "Idempotency-Key": ["Informe uma chave ASCII de 16 a 128 caracteres."] },
    });
  }
  return value;
}

function contentDisposition(fileName: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:csv|zip)$/u.test(fileName) ||
    fileName.includes("..")
  ) {
    throw new ApiHttpError(500, "internal_error", { message: "O nome do download é inválido." });
  }
  return `attachment; filename="${fileName}"`;
}

export function dataExchangeErrorToHttp(error: unknown): unknown {
  if (error instanceof ApiHttpError) return error;
  if (error instanceof IdempotencyConflictError) {
    return new ApiHttpError(409, "idempotency_conflict");
  }
  if (error instanceof IdempotencyInProgressError) {
    return new ApiHttpError(409, "idempotency_conflict", {
      message: "A operação equivalente ainda está em processamento; tente novamente.",
    });
  }
  if (error instanceof ExportAuthorizationError) {
    return new ApiHttpError(403, "permission_denied");
  }
  if (error instanceof ExportNotFoundError) return new ApiHttpError(404, "not_found");
  if (error instanceof ExportExpiredError) {
    return new ApiHttpError(410, "validation_failed", { message: error.message });
  }
  if (error instanceof ExportConflictError) {
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  }
  if (error instanceof ExportFailure) {
    return new ApiHttpError(503, "internal_error", {
      message: "A exportação está indisponível; tente novamente.",
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
  if (error instanceof ImportAuthorizationError) return new ApiHttpError(403, "permission_denied");
  if (error instanceof ImportConflictError)
    return new ApiHttpError(409, "validation_failed", { message: error.message });
  if (error instanceof ImportFailure)
    return new ApiHttpError(422, "validation_failed", { message: error.message });
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
      message: "O armazenamento da exportação está indisponível; tente novamente.",
    });
  }
  return error;
}
