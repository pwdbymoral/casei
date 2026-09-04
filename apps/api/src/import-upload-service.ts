import { createHash, randomUUID } from "node:crypto";
import type {
  ImportCreateRequest,
  ImportDomain,
  ImportPreviewManifestLine,
  ImportPreviewResponse,
} from "@casei/contracts";
import { domainIdSchema, importPreviewResponseSchema } from "@casei/contracts";
import {
  type CsvFieldDefinition,
  parseCsv,
  parseCsvDate,
  parseMinorAmount,
  parseXlsx,
  preflightCsvImport,
} from "@casei/data";
import { hashRequest } from "@casei/database";
import {
  createOpaqueStorageKey,
  ObjectStorageError,
  type ObjectStoragePort,
  type StorageEnvironment,
} from "@casei/storage";
import type {
  ImportUploadApplication,
  ImportUploadConfirmInput,
  ImportUploadPreviewInput,
} from "./data-exchange-routes.js";
import { ImportUploadError } from "./data-exchange-routes.js";

const MAX_IMPORT_FILE_BYTES = 10_000_000;
const MAX_IMPORT_ROWS = 50_000;
const EXPIRY_MS = 24 * 60 * 60 * 1_000;

export interface StoredImportPreview {
  readonly response: ImportPreviewResponse;
}

/** Persistence for the immutable preview manifest; implementations must scope by workspace. */
export interface ImportPreviewStore {
  save(preview: StoredImportPreview): Promise<void>;
  get(workspaceId: string, previewId: string): Promise<StoredImportPreview | null>;
}

export interface ImportFingerprintLookup {
  list(input: {
    readonly workspaceId: string;
    readonly domain: Exclude<ImportDomain, "full">;
    readonly fields: readonly string[];
  }): Promise<ReadonlySet<string>>;
}

export interface ImportUploadServiceOptions {
  readonly storage: ObjectStoragePort;
  readonly previews: ImportPreviewStore;
  readonly fingerprints: ImportFingerprintLookup;
  readonly environment: StorageEnvironment;
  readonly now?: () => Date;
}

/**
 * Server-side upload/preflight boundary. It stores only an opaque temporary
 * object and immutable manifest metadata; applying rows remains DATA-004's
 * worker/domain-command responsibility.
 */
export class ImportUploadService implements ImportUploadApplication {
  private readonly now: () => Date;

  constructor(private readonly options: ImportUploadServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async preview(input: ImportUploadPreviewInput): Promise<ImportPreviewResponse> {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new ImportUploadError("O arquivo excede o limite de 10 MB.");
    }
    const format = formatFromName(input.fileName);
    const contentType =
      format === "csv" && input.contentType === "application/octet-stream"
        ? "text/csv"
        : input.contentType;
    const parsed = await parseTabular(
      input.bytes,
      format,
      input.locale,
      input.sheetName,
      input.sheetIndex,
    );
    const fields = fieldsForDomain(input.domain, input.locale);
    const fingerprintFields = fields
      .map((field) => field.key)
      .filter((key) => !key.startsWith("casei_"));
    const existingFingerprints = await this.options.fingerprints.list({
      workspaceId: input.workspaceId,
      domain: input.domain,
      fields: fingerprintFields,
    });
    const preflight = preflightCsvImport(parsed, fields, {
      locale: input.locale,
      explicitMapping: input.mapping,
      unknownColumns: "warning",
      fingerprint: {
        domain: input.domain,
        fields: fingerprintFields,
        workspaceId: input.workspaceId,
      },
      existingFingerprints,
    });
    const sourceHash = sha256(input.bytes);
    const manifest = preflight.rows.map<ImportPreviewManifestLine>((row) => ({
      lineNumber: row.rowNumber,
      status: row.status,
      rowDigest: hashRequest(row.raw),
      ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    }));
    const previewHash = hashRequest(manifest);
    const mapping = preflight.mapping.mapping;
    const mappingVersion = hashRequest({ domain: input.domain, locale: input.locale, mapping });
    const previewId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + EXPIRY_MS).toISOString();
    const storageKey = createOpaqueStorageKey({
      environment: this.options.environment,
      workspaceId: input.workspaceId,
      jobId: previewId,
      format,
    });
    const response: ImportPreviewResponse = {
      id: previewId,
      workspaceId: input.workspaceId,
      fileName: input.fileName,
      fileSize: input.bytes.byteLength,
      format,
      domain: input.domain,
      headers: Array.from(parsed.headers),
      rows: preflight.rows.map((row) => ({
        rowNumber: row.rowNumber,
        cells: Array.from(row.raw),
        status: row.status,
        errors: row.errors.map((error) => error.message),
        warnings: row.warnings.map((warning) => warning.message),
      })),
      fields: fields.map((field) => ({
        key: field.key,
        label: labelForField(field.key),
        required: field.required ?? false,
        aliases: Array.from(field.aliases ?? []),
      })),
      mapping,
      unknownHeaders: Array.from(preflight.unknownHeaders),
      locale: input.locale,
      ...("sheetName" in parsed
        ? { sheetName: parsed.sheetName, sheetIndex: parsed.sheetIndex }
        : {}),
      serverBacked: true,
      canConfirm: preflight.canConfirm,
      counts: preflight.counts,
      ...(preflight.rows.length >= MAX_IMPORT_ROWS ? { rowLimitExceeded: false } : {}),
      storageKey,
      sourceHash,
      previewHash,
      mappingVersion,
      previewManifest: manifest,
      expiresAt,
    };
    const validated = importPreviewResponseSchema.parse(response);
    let objectStored = false;
    try {
      await this.options.storage.put({
        key: storageKey,
        body: oneChunk(input.bytes),
        contentLength: input.bytes.byteLength,
        contentType,
        format,
        expiresAt,
        sha256: sourceHash,
        now: this.now(),
      });
      objectStored = true;
      await this.options.previews.save({ response: validated });
      return validated;
    } catch (error) {
      if (objectStored) await this.options.storage.delete({ key: storageKey });
      throw error;
    }
  }

  async confirm(input: ImportUploadConfirmInput): Promise<ImportCreateRequest> {
    const stored = await this.options.previews.get(input.workspaceId, input.previewId);
    if (!stored)
      throw new ImportUploadError("A prévia não foi encontrada neste espaço.", "not_found");
    const preview = stored.response;
    if (Date.parse(preview.expiresAt) <= this.now().getTime()) {
      throw new ImportUploadError("A prévia expirou; envie o arquivo novamente.", "expired");
    }
    try {
      const storedObject = await this.options.storage.head({
        key: preview.storageKey,
        now: this.now(),
      });
      if (storedObject.sha256 !== preview.sourceHash) {
        throw new ImportUploadError("O objeto temporário diverge da prévia.", "source_mismatch");
      }
    } catch (error) {
      if (error instanceof ImportUploadError) throw error;
      if (error instanceof ObjectStorageError) {
        if (error.code === "object_not_found") {
          throw new ImportUploadError(
            "O arquivo temporário não foi encontrado; envie o arquivo novamente.",
            "not_found",
          );
        }
        if (error.code === "object_expired") {
          throw new ImportUploadError(
            "O arquivo temporário expirou; envie o arquivo novamente.",
            "expired",
          );
        }
        if (
          error.code === "invalid_object" ||
          error.code === "invalid_format" ||
          error.code === "scan_rejected"
        ) {
          throw new ImportUploadError(error.message, "invalid_file");
        }
        throw new ImportUploadError(
          "O armazenamento da importação está indisponível; tente novamente.",
          "storage_unavailable",
        );
      }
      throw new ImportUploadError(
        "O armazenamento da importação está indisponível; tente novamente.",
        "storage_unavailable",
      );
    }
    const sourceHash = sha256(input.bytes);
    if (sourceHash !== preview.sourceHash) {
      throw new ImportUploadError("O arquivo confirmado diverge da prévia.", "source_mismatch");
    }
    const mappingVersion = hashRequest({
      domain: preview.domain,
      locale: preview.locale,
      mapping: input.mapping,
    });
    if (mappingVersion !== preview.mappingVersion) {
      throw new ImportUploadError("O mapeamento confirmado diverge da prévia.", "source_mismatch");
    }
    if (!preview.canConfirm && input.mode === "all_or_nothing") {
      throw new ImportUploadError("Tudo ou nada exige uma prévia sem erros.", "invalid_preview");
    }
    const duplicateLines = preview.previewManifest
      .filter((line) => line.status === "duplicate")
      .map((line) => line.lineNumber);
    if (
      input.duplicatePolicy === "review" &&
      duplicateLines.length > 0 &&
      (input.acceptedDuplicateLines ?? []).some((line) => !duplicateLines.includes(line))
    ) {
      throw new ImportUploadError(
        "A seleção de duplicatas contém uma linha que não pertence à prévia.",
        "invalid_preview",
      );
    }
    return {
      domain: preview.domain,
      storageKey: preview.storageKey,
      sourceHash: preview.sourceHash,
      mappingVersion: preview.mappingVersion,
      previewHash: preview.previewHash,
      previewManifest: preview.previewManifest,
      mode: input.mode,
      duplicatePolicy: input.duplicatePolicy,
      acceptedDuplicateLines: [...(input.acceptedDuplicateLines ?? [])],
      totalRows: preview.previewManifest.length,
      validRows: preview.counts.valid,
      duplicateRows: preview.counts.duplicates,
      invalidRows: preview.counts.errors,
      expiresAt: preview.expiresAt,
    } as const;
  }
}

async function parseTabular(
  bytes: Uint8Array,
  format: "csv" | "xlsx",
  locale: "pt-BR" | "en-US",
  sheetName?: string,
  sheetIndex?: number,
) {
  try {
    return format === "csv"
      ? parseCsv(bytes, { locale, maxBytes: MAX_IMPORT_FILE_BYTES, maxRows: MAX_IMPORT_ROWS })
      : await parseXlsx(bytes, {
          locale,
          maxBytes: MAX_IMPORT_FILE_BYTES,
          maxRows: MAX_IMPORT_ROWS,
          sheetName,
          sheetIndex,
        });
  } catch (error) {
    throw new ImportUploadError(
      error instanceof Error ? error.message : "O arquivo não pôde ser pré-processado.",
      "invalid_file",
    );
  }
}

function formatFromName(fileName: string): "csv" | "xlsx" {
  const match = /\.([a-z0-9]+)$/iu.exec(fileName);
  if (match?.[1]?.toLocaleLowerCase("en-US") === "csv") return "csv";
  if (match?.[1]?.toLocaleLowerCase("en-US") === "xlsx") return "xlsx";
  throw new ImportUploadError("Use um arquivo CSV ou XLSX.", "invalid_file");
}

function fieldsForDomain(
  domain: Exclude<ImportDomain, "full">,
  locale: "pt-BR" | "en-US",
): readonly CsvFieldDefinition<string>[] {
  if (domain === "products") {
    return [
      field("casei_schema_version", ["casei_schema_version"], false, parseCaseiSchemaVersion),
      field("casei_id", ["casei_id"], false, parseCaseiId),
      field("name", ["nome", "produto", "product"], true),
      field("quantity", ["quantidade", "qty"]),
      field("unit", ["unidade"]),
      field("minimum", ["minimo", "minimum"]),
      field("category", ["categoria", "category"]),
      field("location", ["local", "location"]),
      field("status", ["estado", "status"]),
    ];
  }
  return [
    field("casei_schema_version", ["casei_schema_version"], false, parseCaseiSchemaVersion),
    field("casei_id", ["casei_id"], false, parseCaseiId),
    field("type", ["tipo", "kind"], true),
    field("amount", ["valor", "amount_minor"], true, (value) => parseMinorAmount(value, locale)),
    field("date", ["data", "occurred_on"], true, (value) => parseCsvDate(value, locale)),
    field("state", ["estado", "status"]),
    field("description", ["descricao", "description"]),
    field("category", ["categoria", "category"]),
    field("due_on", ["vencimento", "due_date"]),
    field("payment_method", ["meio", "payment_method"]),
  ];
}

function parseCaseiSchemaVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(normalized)) {
    throw new Error("A versão do schema Casei é inválida.");
  }
  return normalized;
}

function parseCaseiId(value: string): string {
  const parsed = domainIdSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error("O ID Casei é inválido.");
  return parsed.data;
}

function field(
  key: string,
  aliases: readonly string[],
  required = false,
  parse?: (value: string) => string,
): CsvFieldDefinition<string> {
  return { key, aliases, required, ...(parse ? { parse } : {}) };
}

function labelForField(key: string): string {
  return (
    {
      type: "Tipo",
      casei_schema_version: "Versão do schema",
      casei_id: "ID Casei",
      amount: "Valor",
      date: "Data",
      state: "Estado",
      description: "Descrição",
      category: "Categoria",
      due_on: "Vencimento",
      payment_method: "Meio",
      name: "Nome",
      quantity: "Quantidade",
      unit: "Unidade",
      minimum: "Mínimo",
      location: "Local",
      status: "Status",
    }[key] ?? key
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
