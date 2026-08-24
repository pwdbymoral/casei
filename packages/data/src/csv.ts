import { createHash } from "node:crypto";

export const DEFAULT_CSV_LIMITS = Object.freeze({
  /** Ten megabytes, measured from the original byte stream before decoding. */
  maxBytes: 10_000_000,
  /** Header is not counted; this is the maximum number of data records. */
  maxRows: 50_000,
  maxColumns: 256,
  maxCellBytes: 1_000_000,
});

export type CsvEncoding = "utf-8" | "latin1";
export type CsvDelimiter = "," | ";" | "\t";
export type CsvLocale = "pt-BR" | "en-US";

export type CsvImportErrorCode =
  | "file_too_large"
  | "row_limit_exceeded"
  | "column_limit_exceeded"
  | "cell_too_large"
  | "unsupported_encoding"
  | "malformed_csv"
  | "empty_header"
  | "duplicate_header"
  | "invalid_date"
  | "ambiguous_locale"
  | "invalid_amount";

/**
 * Public parser error. The message intentionally does not include raw file
 * content: callers can safely expose its code and row to an API client.
 */
export class CsvImportError extends Error {
  readonly code: CsvImportErrorCode;
  readonly rowNumber?: number;
  readonly columnNumber?: number;

  constructor(
    code: CsvImportErrorCode,
    message: string,
    details: { rowNumber?: number; columnNumber?: number } = {},
  ) {
    super(message);
    this.name = "CsvImportError";
    this.code = code;
    this.rowNumber = details.rowNumber;
    this.columnNumber = details.columnNumber;
  }
}

export interface CsvParserOptions {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellBytes?: number;
  delimiter?: CsvDelimiter;
  encoding?: CsvEncoding;
  /** Helps choose a safe single-column fallback when decimal commas exist. */
  locale?: CsvLocale;
}

export interface CsvRow {
  /** One-based data row number in the source, including the header row. */
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

export interface ParsedCsv {
  readonly encoding: CsvEncoding;
  readonly delimiter: CsvDelimiter;
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
  readonly byteLength: number;
}

function assertPositiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function toBytes(input: string | Uint8Array): { bytes: Uint8Array } {
  if (typeof input === "string") {
    return { bytes: new TextEncoder().encode(input) };
  }
  return { bytes: new Uint8Array(input) };
}

function decodeCsvBytes(
  bytes: Uint8Array,
  requestedEncoding: CsvEncoding | undefined,
): { text: string; encoding: CsvEncoding } {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new CsvImportError(
      "unsupported_encoding",
      "O arquivo deve estar em UTF-8 ou Latin-1; UTF-16 não é aceito.",
    );
  }

  if (requestedEncoding === "latin1") {
    const text = new TextDecoder("iso-8859-1").decode(bytes);
    return { text: stripUtf8Bom(text), encoding: "latin1" };
  }

  if (requestedEncoding === "utf-8" || requestedEncoding === undefined) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { text: stripUtf8Bom(text), encoding: "utf-8" };
    } catch {
      if (requestedEncoding === "utf-8") {
        throw new CsvImportError("unsupported_encoding", "O arquivo não é um UTF-8 válido.");
      }
      const text = new TextDecoder("iso-8859-1").decode(bytes);
      return { text: stripUtf8Bom(text), encoding: "latin1" };
    }
  }

  throw new CsvImportError("unsupported_encoding", "A codificação do arquivo não é suportada.");
}

function stripUtf8Bom(text: string): string {
  return text.startsWith("\ufeff") ? text.slice(1) : text;
}

function hasControlByte(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) return true;
  }
  return false;
}

/** Counts delimiters on the first logical record, ignoring quoted content. */
export function detectCsvDelimiter(text: string, locale?: CsvLocale): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) continue;
    if (character === "\r" || character === "\n") break;
    if (character === "," || character === ";" || character === "\t") {
      counts[character] += 1;
    }
  }

  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  // A one-column pt-BR file commonly contains decimal commas in data rows.
  // With no header delimiter, treating comma as a separator would silently
  // change the row width; semicolon is the safe locale-aware fallback.
  return locale === "pt-BR" ? ";" : ",";
}

function parseCsvRows(
  text: string,
  delimiter: CsvDelimiter,
  limits: Required<Pick<CsvParserOptions, "maxRows" | "maxColumns" | "maxCellBytes">>,
): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let rowNumber = 1;
  let columnNumber = 1;
  let atFieldStart = true;
  let justClosedQuote = false;
  const encoder = new TextEncoder();
  let cellByteLength = 0;

  const appendToCell = (value: string): void => {
    cell += value;
    cellByteLength += encoder.encode(value).byteLength;
    if (cellByteLength > limits.maxCellBytes) {
      throw new CsvImportError("cell_too_large", "Uma célula excede o limite permitido.", {
        rowNumber,
        columnNumber,
      });
    }
  };

  const checkCellSize = (): void => {
    if (cellByteLength > limits.maxCellBytes) {
      throw new CsvImportError("cell_too_large", "Uma célula excede o limite permitido.", {
        rowNumber,
        columnNumber,
      });
    }
  };

  const finishCell = (): void => {
    checkCellSize();
    cells.push(cell);
    cell = "";
    cellByteLength = 0;
    columnNumber += 1;
    atFieldStart = true;
    if (cells.length > limits.maxColumns) {
      throw new CsvImportError("column_limit_exceeded", "A planilha excede o limite de colunas.", {
        rowNumber,
        columnNumber: cells.length,
      });
    }
  };

  const finishRow = (): void => {
    finishCell();
    const isBlank = cells.every((value) => value.trim() === "");
    if (!isBlank || rows.length === 0) {
      if (rows.length > limits.maxRows) {
        throw new CsvImportError("row_limit_exceeded", "A planilha excede o limite de linhas.", {
          rowNumber,
        });
      }
      rows.push({ rowNumber, cells });
    }
    cells = [];
    rowNumber += 1;
    columnNumber = 1;
    atFieldStart = true;
    justClosedQuote = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          appendToCell('"');
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        appendToCell(character);
      }
      atFieldStart = false;
      continue;
    }

    if (character === '"') {
      if (cell.length !== 0 || !atFieldStart || justClosedQuote) {
        throw new CsvImportError("malformed_csv", "Aspas só podem iniciar um campo.", {
          rowNumber,
          columnNumber,
        });
      }
      inQuotes = true;
      atFieldStart = false;
      justClosedQuote = false;
      continue;
    }

    if (justClosedQuote && character !== delimiter && character !== "\r" && character !== "\n") {
      throw new CsvImportError(
        "malformed_csv",
        "Uma célula entre aspas deve terminar no separador ou no fim da linha.",
        {
          rowNumber,
          columnNumber,
        },
      );
    }

    if (character === delimiter) {
      finishCell();
      atFieldStart = true;
      justClosedQuote = false;
      continue;
    }

    if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }

    appendToCell(character);
    atFieldStart = false;
    justClosedQuote = false;
  }

  if (inQuotes) {
    throw new CsvImportError(
      "malformed_csv",
      "O arquivo contém uma célula entre aspas sem fechamento.",
      {
        rowNumber,
        columnNumber,
      },
    );
  }

  if (cell.length > 0 || cells.length > 0 || text.length === 0) finishRow();
  return rows;
}

/**
 * Parses a bounded CSV stream without evaluating formulas or executing any
 * content. Rows with a wrong number of cells are retained for row-level
 * preflight diagnostics instead of being silently truncated.
 */
export function parseCsv(input: string | Uint8Array, options: CsvParserOptions = {}): ParsedCsv {
  const limits = {
    maxBytes: assertPositiveLimit(options.maxBytes, DEFAULT_CSV_LIMITS.maxBytes, "maxBytes"),
    maxRows: assertPositiveLimit(options.maxRows, DEFAULT_CSV_LIMITS.maxRows, "maxRows"),
    maxColumns: assertPositiveLimit(
      options.maxColumns,
      DEFAULT_CSV_LIMITS.maxColumns,
      "maxColumns",
    ),
    maxCellBytes: assertPositiveLimit(
      options.maxCellBytes,
      DEFAULT_CSV_LIMITS.maxCellBytes,
      "maxCellBytes",
    ),
  };
  const { bytes } = toBytes(input);
  if (bytes.byteLength > limits.maxBytes) {
    throw new CsvImportError("file_too_large", "O arquivo excede o limite configurado.");
  }

  const decoded = decodeCsvBytes(bytes, options.encoding);
  if (hasControlByte(decoded.text)) {
    throw new CsvImportError("malformed_csv", "O arquivo contém conteúdo binário inválido.");
  }
  const delimiter = options.delimiter ?? detectCsvDelimiter(decoded.text, options.locale);
  const rows = parseCsvRows(decoded.text, delimiter, limits);
  if (rows.length === 0 || rows[0] === undefined) {
    throw new CsvImportError("empty_header", "A planilha precisa ter um cabeçalho.", {
      rowNumber: 1,
    });
  }

  const headers = rows[0].cells.map((header) => header.trim());
  if (headers.length === 0 || headers.every((header) => header === "")) {
    throw new CsvImportError("empty_header", "A planilha precisa ter um cabeçalho.", {
      rowNumber: rows[0].rowNumber,
    });
  }
  const normalizedHeaders = new Set<string>();
  for (const [index, header] of headers.entries()) {
    const normalized = normalizeHeader(header);
    if (normalized === "") {
      throw new CsvImportError("empty_header", "O cabeçalho não pode ter colunas vazias.", {
        rowNumber: rows[0].rowNumber,
        columnNumber: index + 1,
      });
    }
    if (normalizedHeaders.has(normalized)) {
      throw new CsvImportError("duplicate_header", "O cabeçalho contém colunas duplicadas.", {
        rowNumber: rows[0].rowNumber,
        columnNumber: index + 1,
      });
    }
    normalizedHeaders.add(normalized);
  }

  return {
    encoding: decoded.encoding,
    delimiter,
    headers,
    rows: rows.slice(1),
    byteLength: bytes.byteLength,
  };
}

function removeDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonical comparison key for user-visible column labels. */
export function normalizeHeader(value: string): string {
  return removeDiacritics(value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR"))
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalizes human text without changing its semantic content. */
export function normalizeImportValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export interface CsvFieldDefinition<T = unknown> {
  readonly key: string;
  readonly aliases?: readonly string[];
  readonly required?: boolean;
  readonly parse?: (value: string, context: CsvCellContext) => T;
}

export interface CsvCellContext {
  readonly rowNumber: number;
  readonly field: string;
  readonly locale?: CsvLocale;
}

export interface CsvMappingError {
  readonly code: "unknown_column" | "missing_required" | "ambiguous_mapping" | "duplicate_mapping";
  readonly field?: string;
  readonly header?: string;
  readonly candidates?: readonly string[];
  readonly message: string;
}

export interface CsvColumnMapping {
  readonly mapping: Readonly<Record<string, string>>;
  readonly unknownHeaders: readonly string[];
  readonly missingRequired: readonly string[];
  readonly mappingErrors: readonly CsvMappingError[];
}

function fieldCandidates<T>(field: CsvFieldDefinition<T>): string[] {
  return [field.key, ...(field.aliases ?? [])].map(normalizeHeader);
}

/**
 * Suggests a mapping but does not guess through ambiguity. `explicitMapping`
 * is intentionally separate so an editable UI can send a reviewed mapping.
 */
export function mapCsvColumns<T>(
  headers: readonly string[],
  fields: readonly CsvFieldDefinition<T>[],
  explicitMapping: Readonly<Record<string, string>> = {},
): CsvColumnMapping {
  const mapping: Record<string, string> = {};
  const mappingErrors: CsvMappingError[] = [];
  const assignedHeaders = new Set<string>();

  for (const field of fields) {
    const explicitHeader = explicitMapping[field.key];
    if (explicitHeader !== undefined) {
      const actualHeader = headers.find((header) => header === explicitHeader);
      if (actualHeader === undefined) {
        mappingErrors.push({
          code: "unknown_column",
          field: field.key,
          header: explicitHeader,
          message: "A coluna escolhida não existe no arquivo.",
        });
        continue;
      }
      mapping[field.key] = actualHeader;
      if (assignedHeaders.has(actualHeader)) {
        mappingErrors.push({
          code: "duplicate_mapping",
          field: field.key,
          header: actualHeader,
          message: "A mesma coluna não pode alimentar dois campos.",
        });
      }
      assignedHeaders.add(actualHeader);
      continue;
    }

    const fieldKeys = new Set(fieldCandidates(field));
    const matchingHeaders = headers.filter((header) => fieldKeys.has(normalizeHeader(header)));
    if (matchingHeaders.length === 1) {
      const header = matchingHeaders[0];
      if (header !== undefined) {
        mapping[field.key] = header;
        if (assignedHeaders.has(header)) {
          mappingErrors.push({
            code: "duplicate_mapping",
            field: field.key,
            header,
            message: "A mesma coluna não pode alimentar dois campos.",
          });
        }
        assignedHeaders.add(header);
      }
    } else if (matchingHeaders.length > 1) {
      mappingErrors.push({
        code: "ambiguous_mapping",
        field: field.key,
        candidates: matchingHeaders,
        message: "Mais de uma coluna corresponde ao mesmo campo.",
      });
    } else if (field.required) {
      mappingErrors.push({
        code: "missing_required",
        field: field.key,
        message: "O campo obrigatório não foi mapeado.",
      });
    }
  }

  const unknownHeaders = headers.filter((header) => !assignedHeaders.has(header));

  return {
    mapping,
    unknownHeaders,
    missingRequired: fields
      .filter((field) => field.required && mapping[field.key] === undefined)
      .map((field) => field.key),
    mappingErrors,
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function invalidDate(): CsvImportError {
  return new CsvImportError("invalid_date", "A data não é uma data civil válida.");
}

/** Parses only an explicitly selected locale; slash dates without it are ambiguous. */
export function parseCsvDate(value: string, locale?: CsvLocale): string {
  const normalized = normalizeImportValue(value);
  const canonicalMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  let year: number;
  let month: number;
  let day: number;

  if (canonicalMatch !== null) {
    year = Number(canonicalMatch[1]);
    month = Number(canonicalMatch[2]);
    day = Number(canonicalMatch[3]);
  } else {
    if (locale === undefined) {
      throw new CsvImportError(
        "ambiguous_locale",
        "Selecione o locale para interpretar datas com separador.",
      );
    }
    const match = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(normalized);
    if (match === null) throw invalidDate();
    const first = Number(match[1]);
    const second = Number(match[2]);
    year = Number(match[3]);
    if (locale === "pt-BR") {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw invalidDate();
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function groupingIsValid(value: string, separator: "." | ","): boolean {
  if (!value.includes(separator)) return true;
  return /^\d{1,3}(?:[.,]\d{3})+$/.test(value);
}

/** Converts a localized major-unit amount to canonical integer minor units. */
export function parseMinorAmount(value: string, locale: CsvLocale, scale = 2): string {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 6) {
    throw new RangeError("scale must be between 0 and 6");
  }
  let normalized = normalizeImportValue(value)
    .replace(/^(?:R\$|BRL|USD|US\$|€|£)\s*/iu, "")
    .replace(/\s*(?:BRL|USD|EUR|GBP)$/iu, "")
    .replace(/\s/g, "");
  const sign = normalized.startsWith("-") || normalized.startsWith("+") ? normalized[0] : "";
  if (sign !== "") normalized = normalized.slice(1);
  if (normalized === "") throw new CsvImportError("invalid_amount", "O valor está vazio.");

  const decimalSeparator = locale === "pt-BR" ? "," : ".";
  const groupingSeparator = locale === "pt-BR" ? "." : ",";
  if (
    normalized.includes(decimalSeparator) &&
    normalized.indexOf(decimalSeparator) !== normalized.lastIndexOf(decimalSeparator)
  ) {
    throw new CsvImportError("invalid_amount", "O valor possui mais de uma parte decimal.");
  }
  const parts = normalized.split(decimalSeparator);
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (!/^[\d.,]+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new CsvImportError("invalid_amount", "O valor possui caracteres inválidos.");
  }
  if (whole.includes(groupingSeparator) && !groupingIsValid(whole, groupingSeparator)) {
    throw new CsvImportError("invalid_amount", "O agrupamento de milhares é inválido.");
  }
  const plainWhole = whole.replaceAll(groupingSeparator, "");
  if (!/^\d+$/.test(plainWhole) || fraction.length > scale) {
    throw new CsvImportError("invalid_amount", "O valor possui precisão ou formato inválido.");
  }
  const minor = `${plainWhole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  try {
    if (BigInt(minor || "0") > 999_999_999_999_999n) {
      throw new CsvImportError("invalid_amount", "O valor excede o limite suportado.");
    }
  } catch (error) {
    if (error instanceof CsvImportError) throw error;
    throw new CsvImportError("invalid_amount", "O valor possui formato inválido.");
  }
  return `${sign === "-" ? "-" : ""}${minor || "0"}`;
}

export type CsvRowStatus = "valid" | "duplicate" | "invalid";

export interface CsvRowIssue {
  readonly code: "required" | "row_width" | "unknown_column" | "invalid_value" | CsvImportErrorCode;
  readonly message: string;
  readonly field?: string;
}

export interface CsvPreflightRow {
  readonly rowNumber: number;
  readonly raw: readonly string[];
  readonly values?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly status: CsvRowStatus;
  readonly errors: readonly CsvRowIssue[];
  readonly warnings: readonly CsvRowIssue[];
}

export interface CsvPreflightResult {
  readonly mapping: CsvColumnMapping;
  readonly unknownHeaders: readonly string[];
  readonly mappingErrors: readonly CsvMappingError[];
  readonly rows: readonly CsvPreflightRow[];
  readonly counts: {
    readonly valid: number;
    readonly warnings: number;
    readonly duplicates: number;
    readonly errors: number;
  };
  readonly canConfirm: boolean;
}

export interface CsvFingerprintOptions {
  readonly domain: string;
  readonly fields: readonly string[];
  readonly workspaceId?: string;
}

export interface CsvPreflightOptions {
  readonly locale?: CsvLocale;
  readonly explicitMapping?: Readonly<Record<string, string>>;
  readonly unknownColumns?: "warning" | "error" | "ignore";
  readonly fingerprint?: CsvFingerprintOptions;
  readonly existingFingerprints?: ReadonlySet<string>;
}

function asRecord(values: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(values);
}

/**
 * Validates all rows before any application/storage layer is called. Duplicate
 * fingerprints are suggestions (status `duplicate`), never an implicit delete.
 */
export function preflightCsvImport<T>(
  parsed: ParsedCsv,
  fields: readonly CsvFieldDefinition<T>[],
  options: CsvPreflightOptions = {},
): CsvPreflightResult {
  const mapping = mapCsvColumns(parsed.headers, fields, options.explicitMapping);
  const unknownMode = options.unknownColumns ?? "warning";
  const mappingErrors = [...mapping.mappingErrors];
  if (unknownMode === "error") {
    for (const header of mapping.unknownHeaders) {
      mappingErrors.push({
        code: "unknown_column",
        header,
        message: "A coluna não está mapeada.",
      });
    }
  }

  const seen = new Set(options.existingFingerprints ?? []);
  const rows: CsvPreflightRow[] = [];
  for (const row of parsed.rows) {
    const errors: CsvRowIssue[] = [];
    const warnings: CsvRowIssue[] = [];
    if (row.cells.length !== parsed.headers.length) {
      errors.push({
        code: "row_width",
        message: "A linha possui quantidade de colunas diferente do cabeçalho.",
      });
    }
    if (unknownMode === "warning") {
      for (const header of mapping.unknownHeaders) {
        warnings.push({ code: "unknown_column", message: `Coluna não mapeada: ${header}.` });
      }
    }

    const values: Record<string, unknown> = {};
    for (const field of fields) {
      const header = mapping.mapping[field.key];
      if (header === undefined) continue;
      const columnIndex = parsed.headers.indexOf(header);
      const raw = row.cells[columnIndex] ?? "";
      if (field.required && normalizeImportValue(raw) === "") {
        errors.push({ code: "required", field: field.key, message: "Campo obrigatório vazio." });
        continue;
      }
      if (normalizeImportValue(raw) === "" && !field.required) {
        values[field.key] = undefined;
        continue;
      }
      try {
        values[field.key] =
          field.parse?.(raw, {
            rowNumber: row.rowNumber,
            field: field.key,
            locale: options.locale,
          }) ?? raw;
      } catch (error) {
        if (error instanceof CsvImportError) {
          errors.push({ code: error.code, field: field.key, message: error.message });
        } else {
          errors.push({
            code: "invalid_value",
            field: field.key,
            message: "O valor não pôde ser interpretado.",
          });
        }
      }
    }

    let fingerprint: string | undefined;
    if (options.fingerprint !== undefined && errors.length === 0) {
      fingerprint = fingerprintImportRow(options.fingerprint.domain, values, {
        fields: options.fingerprint.fields,
        workspaceId: options.fingerprint.workspaceId,
      });
    }
    let status: CsvRowStatus = errors.length > 0 ? "invalid" : "valid";
    if (status === "valid" && fingerprint !== undefined && seen.has(fingerprint)) {
      status = "duplicate";
    }
    if (status !== "invalid" && fingerprint !== undefined) seen.add(fingerprint);
    rows.push({
      rowNumber: row.rowNumber,
      raw: row.cells,
      ...(errors.length === 0 ? { values: asRecord(values) } : {}),
      ...(fingerprint === undefined ? {} : { fingerprint }),
      status,
      errors,
      warnings,
    });
  }

  const valid = rows.filter((row) => row.status === "valid").length;
  const duplicates = rows.filter((row) => row.status === "duplicate").length;
  const errors = rows.filter((row) => row.status === "invalid").length;
  const rowWarnings = rows.reduce(
    (total, row) =>
      total + row.warnings.filter((warning) => warning.code !== "unknown_column").length,
    0,
  );
  // An unmapped column is a file-level warning even though its provenance is
  // repeated on each row for an accessible line-by-line report.
  const warnings = (unknownMode === "warning" ? mapping.unknownHeaders.length : 0) + rowWarnings;
  return {
    mapping,
    unknownHeaders: mapping.unknownHeaders,
    mappingErrors,
    rows,
    counts: { valid, warnings, duplicates, errors },
    canConfirm: mappingErrors.length === 0 && errors === 0 && rows.length > 0,
  };
}

function canonicalFingerprintPart(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string") {
    return removeDiacritics(value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR")).replace(
      /\s+/g,
      " ",
    );
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

/** Produces a stable SHA-256 fingerprint for external-row duplicate suggestions. */
export function fingerprintImportRow(
  domain: string,
  row: Readonly<Record<string, unknown>>,
  options: { readonly fields?: readonly string[]; readonly workspaceId?: string } = {},
): string {
  const fields = [...(options.fields ?? Object.keys(row))].sort();
  const payload = [
    ["domain", canonicalFingerprintPart(domain)],
    ["workspace", canonicalFingerprintPart(options.workspaceId)],
    ...fields.map((field) => [field, canonicalFingerprintPart(row[field])] as const),
  ]
    .map(([key, value]) => `${key.length}:${key}${value.length}:${value}`)
    .join("\u001e");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface ProtectedCsvCell {
  readonly value: string;
  readonly logicalValue: string;
  readonly formulaProtected: boolean;
}

/** Excel/LibreOffice formula-injection defense for exported text cells. */
export function protectCsvFormula(value: string): ProtectedCsvCell {
  const formulaLike = /^[\t\r\n ]*[=+\-@]/.test(value);
  return {
    value: formulaLike ? `'${value}` : value,
    logicalValue: value,
    formulaProtected: formulaLike,
  };
}

function escapeCsvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export interface SerializeCsvOptions {
  readonly delimiter?: CsvDelimiter;
  readonly protectFormulas?: boolean;
}

/** Serializes rows with CRLF and RFC4180 quoting; it never evaluates cells. */
export function serializeCsv(
  rows: readonly (readonly string[])[],
  options: SerializeCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  return `${rows
    .map((row) =>
      row
        .map((cell) => {
          const protectedCell =
            options.protectFormulas === false ? cell : protectCsvFormula(cell).value;
          return escapeCsvCell(protectedCell);
        })
        .join(delimiter),
    )
    .join("\r\n")}\r\n`;
}
