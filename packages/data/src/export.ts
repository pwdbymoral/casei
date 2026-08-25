import { createHash, type Hash } from "node:crypto";

import { protectCsvFormula, serializeCsvCell } from "./csv.js";

export const DEFAULT_CSV_EXPORT_LIMITS = Object.freeze({
  maxRows: 50_000,
  maxBytes: 10_000_000,
  maxChunkBytes: 64 * 1024,
  maxCellBytes: 1_000_000,
  maxProtectedCells: 100_000,
});

export type ExportJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly ExportJsonValue[]
  | { readonly [key: string]: ExportJsonValue };

export type ExportCellValue = string | null | undefined;

export type CsvExportErrorCode =
  | "invalid_schema"
  | "invalid_metadata"
  | "invalid_file_name"
  | "invalid_row"
  | "row_limit_exceeded"
  | "file_too_large"
  | "stream_cancelled"
  | "source_failed";

export class CsvExportError extends Error {
  readonly code: CsvExportErrorCode;
  readonly rowNumber?: number;
  readonly column?: string;

  constructor(
    code: CsvExportErrorCode,
    message: string,
    details: { rowNumber?: number; column?: string } = {},
  ) {
    super(message);
    this.name = "CsvExportError";
    this.code = code;
    this.rowNumber = details.rowNumber;
    this.column = details.column;
  }
}

export interface CsvExportColumn {
  readonly key: string;
  readonly label?: string;
}

export type CsvExportRow = Readonly<Record<string, ExportCellValue>>;

export interface VersionedCsvExportOptions {
  readonly domain: string;
  readonly schemaVersion: string;
  readonly generatedAt?: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly filters: ExportJsonValue;
  /** Domain columns; `casei_schema_version` and `casei_id` are automatic. */
  readonly columns: readonly CsvExportColumn[];
  readonly rows: Iterable<CsvExportRow>;
  readonly fileName?: string;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly maxChunkBytes?: number;
  readonly maxCellBytes?: number;
  readonly maxProtectedCells?: number;
}

export interface ExportManifestColumn {
  readonly key: string;
  readonly label?: string;
}

export interface ProtectedExportCell {
  /** One-based data row number; the CSV header is not counted. */
  readonly rowNumber: number;
  readonly column: string;
  readonly logicalValue: string;
}

export interface ExportFileManifest {
  readonly name: string;
  readonly format: "csv";
  readonly rowCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly protectedCells: readonly ProtectedExportCell[];
}

export interface ExportManifest {
  readonly manifestVersion: "1";
  readonly schemaVersion: string;
  readonly domain: string;
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly filters: ExportJsonValue;
  readonly columns: readonly ExportManifestColumn[];
  readonly files: readonly [ExportFileManifest];
}

export interface VersionedCsvExport {
  readonly stream: ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly contentType: "text/csv; charset=utf-8";
  /** Resolves only after the stream is consumed to EOF. */
  readonly manifest: Promise<ExportManifest>;
  readonly manifestJson: Promise<string>;
  readonly manifestSha256: Promise<string>;
}

export interface VersionedZipExportOptions extends VersionedCsvExportOptions {
  /** Archive name; the CSV entry keeps `fileName` from the base options. */
  readonly zipFileName?: string;
}

export interface VersionedZipExport {
  readonly stream: ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly contentType: "application/zip";
  /** Resolves after the CSV entry has been consumed to EOF. */
  readonly manifest: Promise<ExportManifest>;
  readonly manifestJson: Promise<string>;
  readonly manifestSha256: Promise<string>;
}

interface ExportConfig {
  readonly domain: string;
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly filters: ExportJsonValue;
  readonly columns: readonly CsvExportColumn[];
  readonly allColumns: readonly ExportManifestColumn[];
  readonly rows: Iterable<CsvExportRow>;
  readonly fileName: string;
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxChunkBytes: number;
  readonly maxCellBytes: number;
  readonly maxProtectedCells: number;
}

const RESERVED_COLUMNS = new Set(["casei_schema_version", "casei_id"]);
const COLUMN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

function positiveLimit(
  value: number | undefined,
  fallback: number,
  code: CsvExportErrorCode,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new CsvExportError(code, "O limite de exportação é inválido.");
  }
  return resolved;
}

function invalidSchema(message = "O schema de exportação é inválido."): CsvExportError {
  return new CsvExportError("invalid_schema", message);
}

function invalidMetadata(message = "Os metadados de exportação são inválidos."): CsvExportError {
  return new CsvExportError("invalid_metadata", message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonValue(value: unknown, path = "$", seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidMetadata();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw invalidMetadata();
  if (seen.has(value)) throw invalidMetadata();
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidMetadata();
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonValue(record[key], `${path}.${key}`, seen)}`,
      )
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

/** Stable JSON used for manifests and checksum reproducibility. */
export function canonicalExportJson(value: unknown): string {
  return canonicalJsonValue(value);
}

function snapshotJson(value: ExportJsonValue): ExportJsonValue {
  const json = canonicalExportJson(value);
  return JSON.parse(json) as ExportJsonValue;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateInstant(value: string): string {
  if (typeof value !== "string") throw invalidMetadata("O horário de exportação é inválido.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidMetadata("O horário deve ser ISO 8601 UTC com milissegundos.");
  }
  return value;
}

function validateTimeZone(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes(":")) {
    throw invalidMetadata("O fuso deve ser IANA.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw invalidMetadata("O fuso deve ser IANA.");
  }
  return value;
}

function validateFileName(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.csv$/.test(value) ||
    value.includes("..")
  ) {
    throw new CsvExportError("invalid_file_name", "O nome do arquivo de exportação é inválido.");
  }
  return value;
}

function validateConfig(options: VersionedCsvExportOptions): ExportConfig {
  if (typeof options.domain !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(options.domain)) {
    throw invalidSchema();
  }
  if (
    typeof options.schemaVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.schemaVersion)
  ) {
    throw invalidSchema();
  }
  if (typeof options.currency !== "string" || !/^[A-Z]{3}$/.test(options.currency)) {
    throw invalidMetadata();
  }
  if (typeof options.rows?.[Symbol.iterator] !== "function")
    throw new CsvExportError("invalid_row", "A fonte de linhas é inválida.");
  if (!Array.isArray(options.columns)) throw invalidSchema();
  const columns: CsvExportColumn[] = [];
  const keys = new Set<string>(RESERVED_COLUMNS);
  for (const column of options.columns) {
    if (column === null || typeof column !== "object" || typeof column.key !== "string") {
      throw invalidSchema();
    }
    if (!COLUMN_KEY_PATTERN.test(column.key) || keys.has(column.key)) throw invalidSchema();
    if (
      (column.label !== undefined && typeof column.label !== "string") ||
      (typeof column.label === "string" &&
        (column.label.length === 0 || column.label.includes("\r") || column.label.includes("\n")))
    ) {
      throw invalidSchema();
    }
    keys.add(column.key);
    columns.push({ ...column });
  }
  if (columns.length + RESERVED_COLUMNS.size > 256)
    throw invalidSchema("O schema excede o limite de colunas.");
  const allColumns: ExportManifestColumn[] = [
    { key: "casei_schema_version" },
    { key: "casei_id" },
    ...columns.map((column) => ({ ...column })),
  ];
  const fileName = validateFileName(options.fileName ?? `${options.domain}.csv`);
  const generatedAt = validateInstant(options.generatedAt ?? new Date().toISOString());
  const filters = deepFreeze(snapshotJson(options.filters));
  return {
    domain: options.domain,
    schemaVersion: options.schemaVersion,
    generatedAt,
    timeZone: validateTimeZone(options.timeZone),
    currency: options.currency,
    filters,
    columns,
    allColumns,
    rows: options.rows,
    fileName,
    maxRows: positiveLimit(
      options.maxRows,
      DEFAULT_CSV_EXPORT_LIMITS.maxRows,
      "row_limit_exceeded",
    ),
    maxBytes: positiveLimit(options.maxBytes, DEFAULT_CSV_EXPORT_LIMITS.maxBytes, "file_too_large"),
    maxChunkBytes: positiveLimit(
      options.maxChunkBytes,
      DEFAULT_CSV_EXPORT_LIMITS.maxChunkBytes,
      "file_too_large",
    ),
    maxCellBytes: positiveLimit(
      options.maxCellBytes,
      DEFAULT_CSV_EXPORT_LIMITS.maxCellBytes,
      "file_too_large",
    ),
    maxProtectedCells: positiveLimit(
      options.maxProtectedCells,
      DEFAULT_CSV_EXPORT_LIMITS.maxProtectedCells,
      "file_too_large",
    ),
  };
}

function safeExportError(error: unknown, rowNumber?: number): CsvExportError {
  if (error instanceof CsvExportError) return error;
  return new CsvExportError("source_failed", "A fonte de exportação falhou.", { rowNumber });
}

function ensureExportRow(row: unknown, config: ExportConfig, rowNumber: number): CsvExportRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new CsvExportError("invalid_row", "A linha de exportação é inválida.", { rowNumber });
  }
  const record = row as Record<string, unknown>;
  const allowed = new Set(config.allColumns.map((column) => column.key));
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new CsvExportError("invalid_row", "A linha contém campo não declarado no schema.", {
      rowNumber,
      column: unknownKey,
    });
  }
  if (Object.hasOwn(record, "casei_schema_version")) {
    throw new CsvExportError("invalid_row", "A versão do schema é controlada pela exportação.", {
      rowNumber,
      column: "casei_schema_version",
    });
  }
  const id = Object.hasOwn(record, "casei_id") ? record.casei_id : undefined;
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new CsvExportError("invalid_row", "Toda linha exportada precisa de casei_id.", {
      rowNumber,
      column: "casei_id",
    });
  }
  for (const column of config.columns) {
    const value = Object.hasOwn(record, column.key) ? record[column.key] : undefined;
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new CsvExportError("invalid_row", "Os valores exportados devem ser strings ou nulos.", {
        rowNumber,
        column: column.key,
      });
    }
  }
  return record as CsvExportRow;
}

function cellText(value: ExportCellValue): string {
  return value === null || value === undefined ? "" : value;
}

function* rowSegments(
  cells: readonly string[],
  delimiter: string,
): Generator<string, void, undefined> {
  for (const [index, cell] of cells.entries()) {
    yield serializeCsvCell(cell);
    if (index < cells.length - 1) yield delimiter;
  }
  yield "\r\n";
}

/**
 * Creates a one-shot UTF-8 stream. Hashing, row counting and manifest
 * completion happen while the consumer drains the stream, so total output is
 * never accumulated in memory by this package.
 */
export function createVersionedCsvExport(options: VersionedCsvExportOptions): VersionedCsvExport {
  const config = validateConfig(options);
  let resolveManifest!: (manifest: ExportManifest) => void;
  let rejectManifest!: (error: CsvExportError) => void;
  const manifest = new Promise<ExportManifest>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });
  const manifestJson = manifest.then((value) => canonicalExportJson(value));
  const manifestSha256 = manifestJson.then((value) => sha256(value));
  // Consumers may only need the stream. Mark derived metadata promises as
  // observed so a rejected stream cannot become an unhandled process-level
  // rejection while still exposing the rejection to callers that await it.
  void manifestJson.catch(() => undefined);
  void manifestSha256.catch(() => undefined);
  const encoder = new TextEncoder();
  const hash: Hash = createHash("sha256");
  const protectedCells: ProtectedExportCell[] = [];
  let iterator: Iterator<CsvExportRow> | undefined;
  let segments: Iterator<string> | undefined;
  let pendingBytes: Uint8Array | undefined;
  let pendingOffset = 0;
  let rowCount = 0;
  let totalBytes = 0;
  let sourceDone = false;
  let settled = false;
  let iteratorClosed = false;

  const closeIterator = (): void => {
    if (iteratorClosed || iterator === undefined) return;
    iteratorClosed = true;
    try {
      iterator.return?.();
    } catch {
      // Preserve the original stream/manifest failure. Cleanup is best effort,
      // but is always attempted before the failure is exposed to the caller.
    }
  };

  const rejectOnce = (error: CsvExportError): void => {
    if (settled) return;
    closeIterator();
    settled = true;
    rejectManifest(error);
  };

  const finish = (): void => {
    if (settled) return;
    const file: ExportFileManifest = {
      name: config.fileName,
      format: "csv",
      rowCount,
      byteLength: totalBytes,
      sha256: hash.digest("hex"),
      protectedCells: Object.freeze(protectedCells.map((cell) => ({ ...cell }))),
    };
    const result: ExportManifest = Object.freeze({
      manifestVersion: "1",
      schemaVersion: config.schemaVersion,
      domain: config.domain,
      generatedAt: config.generatedAt,
      timeZone: config.timeZone,
      currency: config.currency,
      filters: config.filters,
      columns: Object.freeze(config.allColumns.map((column) => ({ ...column }))),
      files: [file] as const,
    });
    settled = true;
    resolveManifest(result);
  };

  const prepareSegment = (segment: string): void => {
    const bytes = encoder.encode(segment);
    pendingBytes = bytes;
    pendingOffset = 0;
  };

  const nextChunk = (): Uint8Array | null => {
    while (true) {
      if (pendingBytes !== undefined && pendingOffset < pendingBytes.byteLength) {
        const end = Math.min(pendingOffset + config.maxChunkBytes, pendingBytes.byteLength);
        const chunk = pendingBytes.slice(pendingOffset, end);
        pendingOffset = end;
        if (totalBytes + chunk.byteLength > config.maxBytes) {
          throw new CsvExportError("file_too_large", "A exportação excede o limite configurado.");
        }
        totalBytes += chunk.byteLength;
        hash.update(chunk);
        return chunk;
      }
      pendingBytes = undefined;
      pendingOffset = 0;

      if (segments !== undefined) {
        const nextSegment = segments.next();
        if (!nextSegment.done) {
          prepareSegment(nextSegment.value);
          continue;
        }
        segments = undefined;
      }

      if (sourceDone) {
        finish();
        return null;
      }
      if (iterator === undefined) iterator = config.rows[Symbol.iterator]();
      let nextRow: IteratorResult<CsvExportRow>;
      try {
        nextRow = iterator.next();
      } catch (error) {
        throw safeExportError(error, rowCount + 1);
      }
      if (nextRow.done) {
        sourceDone = true;
        continue;
      }
      rowCount += 1;
      if (rowCount > config.maxRows) {
        throw new CsvExportError("row_limit_exceeded", "A exportação excede o limite de linhas.", {
          rowNumber: rowCount,
        });
      }
      const row = ensureExportRow(nextRow.value, config, rowCount);
      const cells = [
        config.schemaVersion,
        cellText(row.casei_id),
        ...config.columns.map((column) =>
          cellText(Object.hasOwn(row, column.key) ? row[column.key] : undefined),
        ),
      ];
      for (const [index, value] of cells.entries()) {
        const column = config.allColumns[index];
        if (column === undefined) continue;
        const protectedCell = protectCsvFormula(value);
        const cellBytes = encoder.encode(protectedCell.value).byteLength;
        if (cellBytes > config.maxCellBytes) {
          throw new CsvExportError("file_too_large", "Uma célula excede o limite configurado.", {
            rowNumber: rowCount,
            column: column.key,
          });
        }
        if (protectedCell.formulaProtected) {
          if (protectedCells.length >= config.maxProtectedCells) {
            throw new CsvExportError(
              "file_too_large",
              "A exportação contém células protegidas demais para o manifesto.",
              { rowNumber: rowCount, column: column.key },
            );
          }
          protectedCells.push({
            rowNumber: rowCount,
            column: column.key,
            logicalValue: protectedCell.logicalValue,
          });
        }
        cells[index] = protectedCell.value;
      }
      segments = rowSegments(cells, ",");
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (segments === undefined && iterator === undefined && !sourceDone) {
          segments = rowSegments(
            config.allColumns.map((column) => column.key),
            ",",
          );
        }
        const chunk = nextChunk();
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      } catch (error) {
        const safe = safeExportError(error, rowCount || undefined);
        rejectOnce(safe);
        controller.error(safe);
      }
    },
    cancel() {
      rejectOnce(
        new CsvExportError("stream_cancelled", "A exportação foi cancelada antes do fim."),
      );
    },
  });

  return {
    stream,
    fileName: config.fileName,
    contentType: "text/csv; charset=utf-8",
    manifest,
    manifestJson,
    manifestSha256,
  };
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_FLAGS = 0x0808;
const ZIP_MAX_UINT32 = 0xffffffff;

interface ZipEntryStats {
  readonly name: Uint8Array;
  readonly crc32: number;
  readonly size: number;
  readonly localOffset: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return value >>> 0;
}

function finishCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZipU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeZipU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function validateZipFileName(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip$/.test(value) ||
    value.includes("..")
  ) {
    throw new CsvExportError("invalid_file_name", "O nome do arquivo de exportação é inválido.");
  }
  return value;
}

function ensureZip32(value: number): void {
  if (!Number.isSafeInteger(value) || value > ZIP_MAX_UINT32) {
    throw new CsvExportError("file_too_large", "O arquivo ZIP excede o limite do formato.");
  }
}

function zipLocalHeader(name: Uint8Array): Uint8Array {
  if (name.byteLength > 0xffff) {
    throw new CsvExportError("invalid_file_name", "O nome de uma entrada ZIP é inválido.");
  }
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  writeZipU32(view, 0, ZIP_LOCAL_SIGNATURE);
  writeZipU16(view, 4, 20);
  writeZipU16(view, 6, ZIP_DATA_DESCRIPTOR_FLAGS);
  writeZipU16(view, 8, 0);
  writeZipU16(view, 26, name.byteLength);
  bytes.set(name, 30);
  return bytes;
}

function zipDataDescriptor(stats: ZipEntryStats): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  writeZipU32(view, 0, ZIP_DESCRIPTOR_SIGNATURE);
  writeZipU32(view, 4, stats.crc32);
  writeZipU32(view, 8, stats.size);
  writeZipU32(view, 12, stats.size);
  return bytes;
}

function zipCentralEntry(stats: ZipEntryStats): Uint8Array {
  if (stats.name.byteLength > 0xffff) {
    throw new CsvExportError("invalid_file_name", "O nome de uma entrada ZIP é inválido.");
  }
  const bytes = new Uint8Array(46 + stats.name.byteLength);
  const view = new DataView(bytes.buffer);
  writeZipU32(view, 0, ZIP_CENTRAL_SIGNATURE);
  writeZipU16(view, 4, 20);
  writeZipU16(view, 6, 20);
  writeZipU16(view, 8, ZIP_DATA_DESCRIPTOR_FLAGS);
  writeZipU16(view, 10, 0);
  writeZipU16(view, 28, stats.name.byteLength);
  writeZipU32(view, 16, stats.crc32);
  writeZipU32(view, 20, stats.size);
  writeZipU32(view, 24, stats.size);
  writeZipU32(view, 42, stats.localOffset);
  bytes.set(stats.name, 46);
  return bytes;
}

function zipEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  ensureZip32(centralSize);
  ensureZip32(centralOffset);
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  writeZipU32(view, 0, ZIP_END_SIGNATURE);
  writeZipU16(view, 8, entryCount);
  writeZipU16(view, 10, entryCount);
  writeZipU32(view, 12, centralSize);
  writeZipU32(view, 16, centralOffset);
  return bytes;
}

async function* versionedZipChunks(
  csvExport: VersionedCsvExport,
): AsyncGenerator<Uint8Array, void, undefined> {
  const encoder = new TextEncoder();
  const csvName = encoder.encode(csvExport.fileName);
  const manifestName = encoder.encode("manifest.json");
  const entries: ZipEntryStats[] = [];
  let archiveOffset = 0;
  let csvReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let csvDone = false;

  try {
    const csvHeader = zipLocalHeader(csvName);
    entries.push({ name: csvName, crc32: 0, size: 0, localOffset: archiveOffset });
    yield csvHeader;
    archiveOffset += csvHeader.byteLength;

    csvReader = csvExport.stream.getReader();
    let csvCrc = 0xffffffff;
    let csvSize = 0;
    while (true) {
      const next = await csvReader.read();
      if (next.done) break;
      const chunk = next.value;
      ensureZip32(csvSize + chunk.byteLength);
      ensureZip32(archiveOffset + chunk.byteLength);
      csvSize += chunk.byteLength;
      archiveOffset += chunk.byteLength;
      csvCrc = updateCrc32(csvCrc, chunk);
      yield chunk;
    }
    csvDone = true;
    const csvStats: ZipEntryStats = {
      name: csvName,
      crc32: finishCrc32(csvCrc),
      size: csvSize,
      localOffset: entries[0]?.localOffset ?? 0,
    };
    entries[0] = csvStats;
    const csvDescriptor = zipDataDescriptor(csvStats);
    ensureZip32(archiveOffset + csvDescriptor.byteLength);
    archiveOffset += csvDescriptor.byteLength;
    yield csvDescriptor;

    const manifestJson = await csvExport.manifestJson;
    const manifestBytes = encoder.encode(manifestJson);
    const manifestHeader = zipLocalHeader(manifestName);
    ensureZip32(archiveOffset + manifestHeader.byteLength);
    entries.push({ name: manifestName, crc32: 0, size: 0, localOffset: archiveOffset });
    yield manifestHeader;
    archiveOffset += manifestHeader.byteLength;

    const manifestStats: ZipEntryStats = {
      name: manifestName,
      crc32: finishCrc32(updateCrc32(0xffffffff, manifestBytes)),
      size: manifestBytes.byteLength,
      localOffset: entries[1]?.localOffset ?? 0,
    };
    ensureZip32(archiveOffset + manifestBytes.byteLength);
    archiveOffset += manifestBytes.byteLength;
    yield manifestBytes;
    const manifestDescriptor = zipDataDescriptor(manifestStats);
    ensureZip32(archiveOffset + manifestDescriptor.byteLength);
    archiveOffset += manifestDescriptor.byteLength;
    yield manifestDescriptor;
    entries[1] = manifestStats;

    const centralOffset = archiveOffset;
    const centralEntries = entries.map(zipCentralEntry);
    const centralSize = centralEntries.reduce((total, entry) => total + entry.byteLength, 0);
    ensureZip32(centralOffset + centralSize + 22);
    for (const entry of centralEntries) {
      archiveOffset += entry.byteLength;
      yield entry;
    }
    const end = zipEndOfCentralDirectory(entries.length, centralSize, centralOffset);
    archiveOffset += end.byteLength;
    yield end;
  } finally {
    if (csvReader !== undefined) {
      if (!csvDone) {
        try {
          await csvReader.cancel("ZIP export cancelled");
        } catch {
          // Preserve the original stream error; the underlying CSV stream also
          // closes its source iterator on cancel/error.
        }
      }
      csvReader.releaseLock();
    }
  }
}

/**
 * Creates a stored ZIP stream containing one versioned CSV and its manifest.
 * The CSV is consumed once and is never accumulated in memory; data
 * descriptors let the archive emit each entry before its final checksum is
 * known. Multi-domain bundles can compose this primitive at the application
 * job boundary.
 */
export function createVersionedZipExport(options: VersionedZipExportOptions): VersionedZipExport {
  const csvExport = createVersionedCsvExport(options);
  const fileName = validateZipFileName(options.zipFileName ?? `${options.domain}.zip`);
  const iterator = versionedZipChunks(csvExport);
  const next = iterator.next.bind(iterator);
  const returnIterator = iterator.return?.bind(iterator);
  let reading = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reading) return;
      reading = true;
      try {
        const result = await next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(safeExportError(error));
      } finally {
        reading = false;
      }
    },
    async cancel() {
      try {
        await returnIterator?.();
      } catch {
        // The stream is already cancelled; preserve the cancellation result.
      }
    },
  });
  void csvExport.manifest.catch(() => undefined);
  void csvExport.manifestJson.catch(() => undefined);
  void csvExport.manifestSha256.catch(() => undefined);
  return {
    stream,
    fileName,
    contentType: "application/zip",
    manifest: csvExport.manifest,
    manifestJson: csvExport.manifestJson,
    manifestSha256: csvExport.manifestSha256,
  };
}
