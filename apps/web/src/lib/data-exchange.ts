import { requireApiOrigin } from "./api-origin";
import type { WorkspaceRole } from "./workspaces";

export const MAX_IMPORT_FILE_BYTES = 10_000_000;
export const MAX_IMPORT_ROWS = 50_000;

export type DataDomain = "transactions" | "products" | "complete";
export type DataFileFormat = "csv" | "xlsx";
export type ImportLocale = "pt-BR" | "en-US";
export type DuplicatePolicy = "ignore" | "import" | "review";
export type ImportApplyMode = "valid_only" | "all_or_nothing";
export type ImportJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "partial"
  | "failed"
  | "canceled";
export type ExportJobStatus = "queued" | "processing" | "completed" | "failed" | "expired";

export type DataField = {
  key: string;
  label: string;
  required: boolean;
  aliases: readonly string[];
};

export type ImportPreviewRow = {
  rowNumber: number;
  cells: readonly string[];
  status: "valid" | "duplicate" | "invalid";
  errors: readonly string[];
  warnings: readonly string[];
};

export type ImportPreview = {
  id: string;
  workspaceId: string;
  fileName: string;
  fileSize: number;
  format: DataFileFormat;
  domain: Exclude<DataDomain, "complete">;
  headers: readonly string[];
  rows: readonly ImportPreviewRow[];
  fields: readonly DataField[];
  mapping: Readonly<Record<string, string>>;
  unknownHeaders: readonly string[];
  locale: ImportLocale;
  serverBacked: boolean;
  canConfirm: boolean;
  counts: { valid: number; warnings: number; duplicates: number; errors: number };
  rowLimitExceeded?: boolean;
  message?: string;
};

export type ImportJob = {
  id: string;
  workspaceId: string;
  status: ImportJobStatus;
  progress: number;
  totalRows: number;
  appliedRows: number;
  ignoredRows: number;
  rejectedRows: number;
  errors: readonly { rowNumber: number; message: string }[];
  createdAt: string;
  expiresAt: string | null;
  message?: string;
};

export type ExportJob = {
  id: string;
  workspaceId: string;
  domain: DataDomain;
  format: "csv" | "zip";
  status: ExportJobStatus;
  progress: number;
  fileName: string | null;
  createdAt: string;
  expiresAt: string | null;
  message?: string;
};

export type PreviewImportInput = {
  file: File;
  domain: Exclude<DataDomain, "complete">;
  locale: ImportLocale;
  mapping?: Readonly<Record<string, string>>;
};

export type StartImportInput = {
  preview: ImportPreview;
  file: File;
  duplicatePolicy: DuplicatePolicy;
  applyMode: ImportApplyMode;
  mapping: Readonly<Record<string, string>>;
};

export type CreateExportInput = {
  domain: DataDomain;
  format: "csv" | "zip";
  from?: string;
  to?: string;
};

export interface DataExchangeAdapter {
  previewImport(workspaceId: string, input: PreviewImportInput): Promise<ImportPreview>;
  startImport(
    workspaceId: string,
    input: StartImportInput,
    idempotencyKey: string,
  ): Promise<ImportJob>;
  getImportJob(workspaceId: string, jobId: string): Promise<ImportJob>;
  retryImport(workspaceId: string, jobId: string, idempotencyKey: string): Promise<ImportJob>;
  cancelImport(workspaceId: string, jobId: string): Promise<ImportJob>;
  listExportJobs(workspaceId: string): Promise<ExportJob[]>;
  createExport(
    workspaceId: string,
    input: CreateExportInput,
    idempotencyKey: string,
  ): Promise<ExportJob>;
  getExportJob(workspaceId: string, jobId: string): Promise<ExportJob>;
  downloadExport(workspaceId: string, jobId: string): Promise<Blob>;
}

export type DataExchangeErrorCode = "offline" | "permission" | "unavailable" | "request_failed";

export class DataExchangeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code: DataExchangeErrorCode = "request_failed",
  ) {
    super(message);
    this.name = "DataExchangeError";
  }
}

const TRANSACTION_FIELDS: readonly DataField[] = [
  { key: "type", label: "Tipo", required: true, aliases: ["tipo", "kind"] },
  { key: "amount", label: "Valor", required: true, aliases: ["valor", "amount_minor"] },
  { key: "date", label: "Data", required: true, aliases: ["data", "occurred_on"] },
  { key: "state", label: "Estado", required: false, aliases: ["estado", "status"] },
  {
    key: "description",
    label: "Descrição",
    required: false,
    aliases: ["descricao", "description"],
  },
  { key: "category", label: "Categoria", required: false, aliases: ["categoria", "category"] },
  { key: "due_on", label: "Vencimento", required: false, aliases: ["vencimento", "due_date"] },
  { key: "payment_method", label: "Meio", required: false, aliases: ["meio", "payment_method"] },
];

const PRODUCT_FIELDS: readonly DataField[] = [
  { key: "name", label: "Nome", required: true, aliases: ["nome", "produto", "product"] },
  { key: "quantity", label: "Quantidade", required: false, aliases: ["quantidade", "qty"] },
  { key: "unit", label: "Unidade", required: false, aliases: ["unidade"] },
  { key: "minimum", label: "Mínimo", required: false, aliases: ["minimo", "minimum"] },
  { key: "category", label: "Categoria", required: false, aliases: ["categoria", "category"] },
  { key: "location", label: "Local", required: false, aliases: ["local", "location"] },
  { key: "status", label: "Status", required: false, aliases: ["estado", "status"] },
];

export function dataFieldsForDomain(domain: Exclude<DataDomain, "complete">): readonly DataField[] {
  return domain === "transactions" ? TRANSACTION_FIELDS : PRODUCT_FIELDS;
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function inferMapping(
  headers: readonly string[],
  fields: readonly DataField[],
  explicitMapping: Readonly<Record<string, string>> = {},
): { mapping: Record<string, string>; unknownHeaders: string[]; missingRequired: string[] } {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  for (const field of fields) {
    const explicit = explicitMapping[field.key];
    if (explicit && headers.includes(explicit)) {
      mapping[field.key] = explicit;
      used.add(explicit);
      continue;
    }
    const candidateKeys = [field.key, ...field.aliases].map(normalizeHeader);
    const candidate = candidateKeys.map((key) => normalized.get(key)).find(Boolean);
    if (candidate) {
      mapping[field.key] = candidate;
      used.add(candidate);
    }
  }
  return {
    mapping,
    unknownHeaders: headers.filter((header) => !used.has(header)),
    missingRequired: fields
      .filter((field) => field.required && !mapping[field.key])
      .map((field) => field.key),
  };
}

function splitCsvLine(line: string, delimiter: "," | ";" | "\t"): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function detectPreviewDelimiter(text: string, locale: ImportLocale): "," | ";" | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates: Array<"," | ";" | "\t"> = [",", ";", "\t"];
  const counts = candidates.map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  }));
  counts.sort((left, right) => right.count - left.count);
  return counts[0]?.count ? counts[0].delimiter : locale === "pt-BR" ? ";" : ",";
}

export function parseLocalCsvPreview(
  text: string,
  options: {
    domain: Exclude<DataDomain, "complete">;
    locale: ImportLocale;
    mapping?: Readonly<Record<string, string>>;
  },
): Pick<
  ImportPreview,
  "headers" | "rows" | "mapping" | "unknownHeaders" | "canConfirm" | "counts"
> & {
  rowLimitExceeded: boolean;
  message?: string;
} {
  const delimiter = detectPreviewDelimiter(text, options.locale);
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line, index, all) => line !== "" || index < all.length - 1);
  const headers = (lines.shift() ?? "").split(delimiter).map((header) => header.trim());
  const fields = dataFieldsForDomain(options.domain);
  const inferred = inferMapping(headers, fields, options.mapping);
  const seenRows = new Set<string>();
  const rowLimitExceeded = lines.length > MAX_IMPORT_ROWS;
  const rows: ImportPreviewRow[] = lines.slice(0, MAX_IMPORT_ROWS).map((line, index) => {
    const cells = splitCsvLine(line, delimiter);
    const errors: string[] = [];
    for (const field of fields.filter((item) => item.required)) {
      const header = inferred.mapping[field.key];
      const value = header ? cells[headers.indexOf(header)]?.trim() : "";
      if (!value) errors.push(`${field.label} é obrigatório.`);
    }
    const warnings = inferred.unknownHeaders.map((header) => `Coluna não mapeada: ${header}.`);
    const fingerprint = cells
      .map((cell) => cell.normalize("NFKC").trim().toLocaleLowerCase("pt-BR"))
      .join("\u001f");
    const duplicate = errors.length === 0 && seenRows.has(fingerprint);
    seenRows.add(fingerprint);
    return {
      rowNumber: index + 2,
      cells,
      status: errors.length ? "invalid" : duplicate ? "duplicate" : "valid",
      errors,
      warnings,
    };
  });
  const valid = rows.filter((row) => row.status === "valid").length;
  const duplicates = rows.filter((row) => row.status === "duplicate").length;
  const errors = rows.filter((row) => row.status === "invalid").length;
  const warnings = rows.reduce((total, row) => total + row.warnings.length, 0);
  return {
    headers,
    rows,
    mapping: inferred.mapping,
    unknownHeaders: inferred.unknownHeaders,
    canConfirm:
      !rowLimitExceeded && rows.length > 0 && valid > 0 && inferred.missingRequired.length === 0,
    counts: { valid, warnings, duplicates, errors },
    rowLimitExceeded,
    ...(rowLimitExceeded
      ? {
          message: `O arquivo excede o limite de ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas.`,
        }
      : inferred.missingRequired.length
        ? { message: "Mapeie os campos obrigatórios para continuar." }
        : {}),
  };
}

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function formatDate(value: string): string {
  return new Date(value).toISOString();
}

function extensionFor(file: File): DataFileFormat | null {
  const lower = file.name.toLocaleLowerCase("pt-BR");
  if (lower.endsWith(".csv") || file.type === "text/csv") return "csv";
  if (lower.endsWith(".xlsx") || file.type.includes("spreadsheetml")) return "xlsx";
  return null;
}

function assertFile(file: File): DataFileFormat {
  const format = extensionFor(file);
  if (!format) throw new DataExchangeError("Escolha um arquivo CSV ou XLSX.");
  if (file.size > MAX_IMPORT_FILE_BYTES)
    throw new DataExchangeError("O arquivo excede o limite de 10 MB. Escolha uma versão menor.");
  return format;
}

async function localPreview(
  workspaceId: string,
  input: PreviewImportInput,
  serverBacked: boolean,
): Promise<ImportPreview> {
  const format = assertFile(input.file);
  const fields = dataFieldsForDomain(input.domain);
  if (format === "xlsx") {
    return {
      id: id("preview"),
      workspaceId,
      fileName: input.file.name,
      fileSize: input.file.size,
      format,
      domain: input.domain,
      headers: [],
      rows: [],
      fields,
      mapping: input.mapping ?? {},
      unknownHeaders: [],
      locale: input.locale,
      serverBacked,
      canConfirm: false,
      counts: { valid: 0, warnings: 1, duplicates: 0, errors: 0 },
      rowLimitExceeded: false,
      message: serverBacked
        ? undefined
        : "A prévia XLSX depende do servidor. Envie o arquivo quando DATA-004 estiver disponível.",
    };
  }
  const parsed = parseLocalCsvPreview(await input.file.text(), input);
  const inferred = inferMapping(parsed.headers, fields, input.mapping);
  return {
    id: id("preview"),
    workspaceId,
    fileName: input.file.name,
    fileSize: input.file.size,
    format,
    domain: input.domain,
    headers: parsed.headers,
    rows: parsed.rows,
    fields,
    mapping: inferred.mapping,
    unknownHeaders: inferred.unknownHeaders,
    locale: input.locale,
    serverBacked,
    canConfirm: parsed.canConfirm && inferred.missingRequired.length === 0,
    counts: parsed.counts,
    rowLimitExceeded: parsed.rowLimitExceeded,
    message: parsed.message,
  };
}

async function responseError(response: Response): Promise<DataExchangeError> {
  if (response.status === 401 || response.status === 403)
    return new DataExchangeError(
      "Você não tem permissão para acessar este espaço.",
      response.status,
      "permission",
    );
  if (response.status === 404)
    return new DataExchangeError(
      "A importação/exportação ainda não está disponível neste ambiente.",
      404,
      "unavailable",
    );
  let message = "Não foi possível concluir a operação.";
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) message = body.message;
  } catch {
    // Keep a safe generic message when the boundary did not return JSON.
  }
  return new DataExchangeError(message, response.status);
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "include", cache: "no-store" });
  } catch {
    throw new DataExchangeError("Não foi possível conectar ao Casei.", undefined, "offline");
  }
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

function workspacePath(workspaceId: string, suffix: string): string {
  return `${requireApiOrigin()}/v1/workspaces/${encodeURIComponent(workspaceId)}/data${suffix}`;
}

const httpDataExchangeAdapter: DataExchangeAdapter = {
  async previewImport(workspaceId, input) {
    assertFile(input.file);
    if (globalThis.navigator?.onLine === false) {
      if (extensionFor(input.file) === "xlsx") {
        throw new DataExchangeError(
          "A prévia XLSX precisa de conexão. CSV pode ser revisado offline.",
          undefined,
          "offline",
        );
      }
      return localPreview(workspaceId, input, false);
    }
    const form = new FormData();
    form.set("file", input.file);
    form.set("domain", input.domain);
    form.set("locale", input.locale);
    if (input.mapping) form.set("mapping", JSON.stringify(input.mapping));
    return requestJson<ImportPreview>(workspacePath(workspaceId, "/imports/previews"), {
      method: "POST",
      body: form,
      headers: { Accept: "application/json" },
    });
  },
  startImport(workspaceId, input, idempotencyKey) {
    const form = new FormData();
    form.set("file", input.file);
    form.set("previewId", input.preview.id);
    form.set("mapping", JSON.stringify(input.mapping));
    form.set("duplicatePolicy", input.duplicatePolicy);
    form.set("applyMode", input.applyMode);
    return requestJson<ImportJob>(workspacePath(workspaceId, "/imports"), {
      method: "POST",
      body: form,
      headers: { Accept: "application/json", "Idempotency-Key": idempotencyKey },
    });
  },
  getImportJob: (workspaceId, jobId) =>
    requestJson(workspacePath(workspaceId, `/imports/${encodeURIComponent(jobId)}`)),
  retryImport: (workspaceId, jobId, idempotencyKey) =>
    requestJson(workspacePath(workspaceId, `/imports/${encodeURIComponent(jobId)}/retry`), {
      method: "POST",
      headers: { Accept: "application/json", "Idempotency-Key": idempotencyKey },
    }),
  cancelImport: (workspaceId, jobId) =>
    requestJson(workspacePath(workspaceId, `/imports/${encodeURIComponent(jobId)}/cancel`), {
      method: "POST",
      headers: { Accept: "application/json" },
    }),
  listExportJobs: (workspaceId) => requestJson(workspacePath(workspaceId, "/exports")),
  createExport: (workspaceId, input, idempotencyKey) =>
    requestJson(workspacePath(workspaceId, "/exports"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    }),
  getExportJob: (workspaceId, jobId) =>
    requestJson(workspacePath(workspaceId, `/exports/${encodeURIComponent(jobId)}`)),
  async downloadExport(workspaceId, jobId) {
    let response: Response;
    try {
      response = await fetch(
        workspacePath(workspaceId, `/exports/${encodeURIComponent(jobId)}/download`),
        {
          credentials: "include",
          cache: "no-store",
        },
      );
    } catch {
      throw new DataExchangeError("Não foi possível conectar ao Casei.", undefined, "offline");
    }
    if (!response.ok) throw await responseError(response);
    return response.blob();
  },
};

const fixtureImports = new Map<string, ImportJob>();
const fixtureExports = new Map<string, ExportJob>();
const fixtureImportKeys = new Map<string, ImportJob>();
const fixtureRetryKeys = new Map<string, ImportJob>();
const fixtureExportKeys = new Map<string, ExportJob>();

function fixtureKey(workspaceId: string, key: string): string {
  return `${workspaceId}\u001f${key}`;
}

function fixturePermission(message: string): DataExchangeError {
  return new DataExchangeError(message, 403, "permission");
}

function rememberImport(job: ImportJob): ImportJob {
  fixtureImports.set(job.id, job);
  for (const [key, value] of fixtureImportKeys) {
    if (value.id === job.id) fixtureImportKeys.set(key, job);
  }
  for (const [key, value] of fixtureRetryKeys) {
    if (value.id === job.id) fixtureRetryKeys.set(key, job);
  }
  return job;
}

function rememberExport(job: ExportJob): ExportJob {
  fixtureExports.set(job.id, job);
  for (const [key, value] of fixtureExportKeys) {
    if (value.id === job.id) fixtureExportKeys.set(key, job);
  }
  return job;
}

const fixtureDataExchangeAdapter: DataExchangeAdapter = {
  previewImport: (workspaceId, input) => localPreview(workspaceId, input, false),
  async startImport(workspaceId, input, idempotencyKey) {
    const replayKey = fixtureKey(workspaceId, idempotencyKey);
    const replay = fixtureImportKeys.get(replayKey);
    if (replay) return replay;
    if (!input.preview.canConfirm || input.preview.rowLimitExceeded)
      throw new DataExchangeError("Corrija a prévia antes de confirmar a importação.");
    if (input.applyMode === "all_or_nothing" && input.preview.counts.errors > 0)
      throw new DataExchangeError("Tudo ou nada exige uma prévia sem erros.");
    const duplicateRows = input.preview.rows.filter((row) => row.status === "duplicate");
    if (input.duplicatePolicy === "review" && duplicateRows.length > 0) {
      const reviewJob: ImportJob = {
        id: id("import"),
        workspaceId,
        status: "failed",
        progress: 0,
        totalRows: input.preview.rows.length,
        appliedRows: 0,
        ignoredRows: 0,
        rejectedRows: duplicateRows.length,
        errors: duplicateRows.map((row) => ({
          rowNumber: row.rowNumber,
          message: "Duplicata provável aguardando revisão; nenhuma linha foi aplicada.",
        })),
        createdAt: formatDate(new Date().toISOString()),
        expiresAt: formatDate(new Date(Date.now() + 86_400_000).toISOString()),
        message: "A política de revisão exige uma decisão antes de aplicar duplicatas prováveis.",
      };
      fixtureImportKeys.set(replayKey, reviewJob);
      return rememberImport(reviewJob);
    }
    const job: ImportJob = {
      id: id("import"),
      workspaceId,
      status: "processing",
      progress: 0,
      totalRows: input.preview.rows.length,
      appliedRows: 0,
      ignoredRows: input.duplicatePolicy === "ignore" ? input.preview.counts.duplicates : 0,
      rejectedRows: input.preview.counts.errors,
      errors: input.preview.rows
        .filter((row) => row.status === "invalid")
        .map((row) => ({ rowNumber: row.rowNumber, message: row.errors.join(" ") })),
      createdAt: formatDate(new Date().toISOString()),
      expiresAt: formatDate(new Date(Date.now() + 86_400_000).toISOString()),
    };
    fixtureImportKeys.set(replayKey, job);
    return rememberImport(job);
  },
  async getImportJob(workspaceId, jobId) {
    const current = fixtureImports.get(jobId);
    if (!current) throw new DataExchangeError("Importação não encontrada.", 404);
    if (current.workspaceId !== workspaceId)
      throw fixturePermission("Esta importação pertence a outro espaço.");
    if (current.status === "processing") {
      const progress = Math.min(100, current.progress + 35);
      const appliedRows =
        Math.round((current.totalRows * progress) / 100) -
        current.rejectedRows -
        current.ignoredRows;
      const next = {
        ...current,
        progress,
        appliedRows: Math.max(0, appliedRows),
        status: progress === 100 ? (current.rejectedRows ? "partial" : "completed") : "processing",
      } as ImportJob;
      return rememberImport(next);
    }
    return current;
  },
  async retryImport(workspaceId, jobId, idempotencyKey) {
    const current = fixtureImports.get(jobId);
    if (!current) throw new DataExchangeError("Importação não encontrada.", 404);
    if (current.workspaceId !== workspaceId)
      throw fixturePermission("Esta importação pertence a outro espaço.");
    const replayKey = fixtureKey(workspaceId, idempotencyKey);
    const replay = fixtureRetryKeys.get(replayKey);
    if (replay) return replay;
    if (current.errors.some((error) => error.message.includes("aguardando revisão"))) {
      fixtureRetryKeys.set(replayKey, current);
      return current;
    }
    const next = { ...current, status: "processing" as const, progress: 0, appliedRows: 0 };
    fixtureRetryKeys.set(replayKey, next);
    return rememberImport(next);
  },
  async cancelImport(workspaceId, jobId) {
    const current = fixtureImports.get(jobId);
    if (!current) throw new DataExchangeError("Importação não encontrada.", 404);
    if (current.workspaceId !== workspaceId)
      throw fixturePermission("Esta importação pertence a outro espaço.");
    const next = {
      ...current,
      status: "canceled" as const,
      message: "A aplicação foi cancelada; os lotes já confirmados foram mantidos.",
    };
    return rememberImport(next);
  },
  async listExportJobs(workspaceId) {
    return [...fixtureExports.values()].filter((job) => job.workspaceId === workspaceId);
  },
  async createExport(workspaceId, input, idempotencyKey) {
    const replayKey = fixtureKey(workspaceId, idempotencyKey);
    const replay = fixtureExportKeys.get(replayKey);
    if (replay) return replay;
    const job: ExportJob = {
      id: id("export"),
      workspaceId,
      domain: input.domain,
      format: input.format,
      status: "processing",
      progress: 0,
      fileName: `${input.domain}-${input.format}.${input.format === "zip" ? "zip" : "csv"}`,
      createdAt: formatDate(new Date().toISOString()),
      expiresAt: formatDate(new Date(Date.now() + 86_400_000).toISOString()),
    };
    fixtureExportKeys.set(replayKey, job);
    return rememberExport(job);
  },
  async getExportJob(workspaceId, jobId) {
    const current = fixtureExports.get(jobId);
    if (!current) throw new DataExchangeError("Exportação não encontrada.", 404);
    if (current.workspaceId !== workspaceId)
      throw fixturePermission("Esta exportação pertence a outro espaço.");
    if (current.status === "processing") {
      const progress = Math.min(100, current.progress + 50);
      const next = {
        ...current,
        progress,
        status: progress === 100 ? "completed" : "processing",
      } as ExportJob;
      return rememberExport(next);
    }
    return current;
  },
  async downloadExport(workspaceId, jobId) {
    const job = fixtureExports.get(jobId);
    if (!job) throw new DataExchangeError("Exportação não encontrada.", 404);
    if (job.workspaceId !== workspaceId)
      throw fixturePermission("Esta exportação pertence a outro espaço.");
    if (job.status !== "completed")
      throw new DataExchangeError("A exportação ainda não está pronta.");
    const content = "casei_schema_version,casei_id\n1,fixture\n";
    return new Blob([content], {
      type: job.format === "zip" ? "application/zip" : "text/csv;charset=utf-8",
    });
  },
};

export function dataExchangeAdapterForEnvironment(
  options: { fixtures?: boolean } = {},
): DataExchangeAdapter {
  return options.fixtures ? fixtureDataExchangeAdapter : httpDataExchangeAdapter;
}

export function canImportData(role: WorkspaceRole): boolean {
  return role === "owner" || role === "member";
}

export function canExportData(_role: WorkspaceRole): boolean {
  return true;
}

export function formatDataFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function protectReportCell(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function serializeReportCell(value: string): string {
  return `"${protectReportCell(value).replaceAll('"', '""')}"`;
}

export function serializeImportErrorReport(
  errors: readonly { rowNumber: number; message: string }[],
): string {
  return [
    "linha,mensagem",
    ...errors.map(({ rowNumber, message }) => `${rowNumber},${serializeReportCell(message)}`),
  ].join("\n");
}

export function importStatusLabel(status: ImportJobStatus): string {
  return {
    queued: "Na fila",
    processing: "Processando",
    completed: "Concluída",
    partial: "Concluída parcialmente",
    failed: "Falhou",
    canceled: "Cancelada",
  }[status];
}

export function exportStatusLabel(status: ExportJobStatus): string {
  return {
    queued: "Na fila",
    processing: "Processando",
    completed: "Pronta para baixar",
    failed: "Falhou",
    expired: "Expirada",
  }[status];
}
