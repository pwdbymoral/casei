import ExcelJS from "exceljs";

import {
  CsvImportError,
  type CsvLocale,
  DEFAULT_CSV_LIMITS,
  normalizeHeader,
  type ParsedTabular,
  type TabularRow,
} from "./csv.js";

export interface XlsxParserOptions {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxCellBytes?: number;
  /** Expanded ZIP payload budget, in addition to the source-byte budget. */
  readonly maxUncompressedBytes?: number;
  readonly sheetName?: string;
  /** Zero-based worksheet index. Use either sheetName or sheetIndex. */
  readonly sheetIndex?: number;
  readonly locale?: CsvLocale;
}

export interface ParsedXlsx extends ParsedTabular {
  readonly format: "xlsx";
  readonly sheetName: string;
  readonly sheetIndex: number;
  readonly byteLength: number;
}

export const DEFAULT_XLSX_LIMITS = Object.freeze({
  ...DEFAULT_CSV_LIMITS,
  /** Protects the in-memory ExcelJS loader from compressed ZIP expansion. */
  maxUncompressedBytes: 100_000_000,
});

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const ZIP_ENTRY_FIXED_BYTES = 46;

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function importError(
  code: ConstructorParameters<typeof CsvImportError>[0],
  message: string,
  rowNumber?: number,
  columnNumber?: number,
): CsvImportError {
  return new CsvImportError(code, message, { rowNumber, columnNumber });
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - (ZIP_MAX_COMMENT_BYTES + 22));
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw importError("invalid_xlsx", "O arquivo XLSX não contém um diretório ZIP válido.");
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw importError("invalid_xlsx", "O arquivo XLSX contém nome de entrada inválido.");
  }
}

function validateZipPath(name: string): void {
  if (name.startsWith("/") || name.split("/").some((part) => part === "..")) {
    throw importError("invalid_xlsx", "O arquivo XLSX contém caminho de entrada inválido.");
  }
}

/**
 * Checks ZIP metadata before ExcelJS inflates anything. XLSX is a ZIP format;
 * names are sufficient to reject VBA and external-link parts, while the
 * uncompressed-size budget bounds expansion before the workbook is loaded.
 */
function inspectXlsxContainer(bytes: Uint8Array, maxUncompressedBytes: number): void {
  if (bytes.length < 4 || readU32(bytes, 0) !== 0x04034b50) {
    throw importError("invalid_xlsx", "O arquivo não é um XLSX válido.");
  }

  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = readU16(bytes, eocd + 4);
  const centralDirectoryDisk = readU16(bytes, eocd + 6);
  const entriesOnDisk = readU16(bytes, eocd + 8);
  const entries = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > eocd
  ) {
    throw importError("invalid_xlsx", "O arquivo XLSX usa um ZIP não suportado.");
  }

  let offset = centralOffset;
  let expandedBytes = 0;
  for (let entryIndex = 0; entryIndex < entries; entryIndex += 1) {
    if (
      offset + ZIP_ENTRY_FIXED_BYTES > bytes.length ||
      readU32(bytes, offset) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw importError("invalid_xlsx", "O diretório ZIP do XLSX está corrompido.");
    }
    const flags = readU16(bytes, offset + 8);
    const compression = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const recordLength = ZIP_ENTRY_FIXED_BYTES + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.length) {
      throw importError("invalid_xlsx", "O diretório ZIP do XLSX está corrompido.");
    }
    const name = decodeZipName(
      bytes.slice(offset + ZIP_ENTRY_FIXED_BYTES, offset + ZIP_ENTRY_FIXED_BYTES + nameLength),
    );
    validateZipPath(name);
    if ((flags & 0x0001) !== 0) {
      throw importError("unsupported_format", "XLSX criptografado não é aceito.");
    }
    if (compression !== 0 && compression !== 8) {
      throw importError("unsupported_format", "O XLSX usa compressão não suportada.");
    }
    if (/(?:^|\/)vbaProject(?:Signature)?\.bin$/iu.test(name)) {
      throw importError("macro_detected", "XLSX com macros não é aceito.");
    }
    if (/(?:^|\/)externalLinks(?:\/|$)/iu.test(name)) {
      throw importError("external_link_detected", "XLSX com links externos não é aceito.");
    }
    expandedBytes += uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxUncompressedBytes) {
      throw importError("file_too_large", "O conteúdo descompactado do XLSX excede o limite.");
    }
    if (compressedSize > bytes.length || uncompressedSize > maxUncompressedBytes) {
      throw importError("file_too_large", "Uma entrada descompactada do XLSX excede o limite.");
    }
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw importError("invalid_xlsx", "O diretório ZIP do XLSX está inconsistente.");
  }
}

function dateToCellText(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw importError("invalid_xlsx", "O XLSX contém uma data inválida.");
  }
  return value.toISOString().slice(0, 10);
}

function numberToCellText(value: number, locale: CsvLocale | undefined): string {
  if (!Number.isFinite(value)) {
    throw importError("invalid_xlsx", "O XLSX contém um número inválido.");
  }
  return new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : "en-US", {
    useGrouping: false,
    maximumFractionDigits: 15,
  }).format(value);
}

function isCellError(value: unknown): value is { error: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function cellValueToText(
  value: ExcelJS.CellValue,
  locale: CsvLocale | undefined,
  rowNumber: number,
  columnNumber: number,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return numberToCellText(value, locale);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return dateToCellText(value);
  if (isCellError(value)) {
    throw importError(
      "invalid_xlsx",
      "O XLSX contém uma célula com erro.",
      rowNumber,
      columnNumber,
    );
  }
  if ("formula" in value || "sharedFormula" in value) {
    const result = value.result;
    if (result === undefined) {
      throw importError(
        "formula_without_cached_value",
        "A fórmula não possui valor armazenado para importação segura.",
        rowNumber,
        columnNumber,
      );
    }
    return cellValueToText(result, locale, rowNumber, columnNumber);
  }
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("hyperlink" in value) return value.text;
  throw importError(
    "invalid_xlsx",
    "O XLSX contém um tipo de célula não suportado.",
    rowNumber,
    columnNumber,
  );
}

function rowIsEmpty(row: TabularRow): boolean {
  return row.cells.every((cell) => cell.trim() === "");
}

function selectWorksheet(
  workbook: ExcelJS.Workbook,
  options: XlsxParserOptions,
): { worksheet: ExcelJS.Worksheet; index: number } {
  if (options.sheetName !== undefined && options.sheetIndex !== undefined) {
    throw importError("invalid_xlsx", "Escolha sheetName ou sheetIndex, não ambos.");
  }
  if (
    options.sheetIndex !== undefined &&
    (!Number.isSafeInteger(options.sheetIndex) || options.sheetIndex < 0)
  ) {
    throw importError("invalid_xlsx", "O índice da planilha é inválido.");
  }
  const visible = workbook.worksheets.filter((worksheet) => worksheet.state === "visible");
  if (visible.length === 0) {
    throw importError("sheet_not_found", "O XLSX não possui planilha visível.");
  }
  let worksheet: ExcelJS.Worksheet | undefined;
  if (options.sheetName !== undefined) worksheet = workbook.getWorksheet(options.sheetName);
  else if (options.sheetIndex !== undefined) worksheet = workbook.worksheets[options.sheetIndex];
  else if (visible.length === 1) worksheet = visible[0];
  else throw importError("sheet_selection_required", "Selecione uma planilha do XLSX.");
  if (worksheet === undefined || worksheet.state !== "visible") {
    throw importError("sheet_not_found", "A planilha selecionada não existe ou está oculta.");
  }
  return { worksheet, index: workbook.worksheets.indexOf(worksheet) };
}

function readWorksheet(
  worksheet: ExcelJS.Worksheet,
  options: Required<Pick<XlsxParserOptions, "maxRows" | "maxColumns" | "maxCellBytes">> &
    Pick<XlsxParserOptions, "locale">,
): Omit<ParsedXlsx, "format" | "sheetName" | "sheetIndex" | "byteLength"> {
  if (worksheet.rowCount < 1 || worksheet.actualRowCount < 1 || worksheet.columnCount < 1) {
    throw importError("empty_header", "A planilha precisa ter um cabeçalho.", 1);
  }
  if (worksheet.rowCount - 1 > options.maxRows) {
    throw importError(
      "row_limit_exceeded",
      "A planilha excede o limite de linhas.",
      options.maxRows + 2,
    );
  }
  if (worksheet.columnCount > options.maxColumns) {
    throw importError("column_limit_exceeded", "A planilha excede o limite de colunas.", 1);
  }

  const headerRow = worksheet.getRow(1);
  const headerWidth = Math.max(headerRow.cellCount, worksheet.actualColumnCount);
  if (headerWidth < 1 || headerWidth > options.maxColumns) {
    throw importError("empty_header", "A planilha precisa ter um cabeçalho.", 1);
  }
  const encoder = new TextEncoder();
  const headers = Array.from({ length: headerWidth }, (_, index) => {
    const header = cellValueToText(
      headerRow.getCell(index + 1).value,
      options.locale,
      1,
      index + 1,
    ).trim();
    if (encoder.encode(header).byteLength > options.maxCellBytes) {
      throw importError("cell_too_large", "Uma célula excede o limite permitido.", 1, index + 1);
    }
    return header;
  });
  const normalized = new Set<string>();
  for (const [index, header] of headers.entries()) {
    const key = normalizeHeader(header);
    if (key === "") {
      throw importError("empty_header", "O cabeçalho não pode ter colunas vazias.", 1, index + 1);
    }
    if (normalized.has(key)) {
      throw importError("duplicate_header", "O cabeçalho contém colunas duplicadas.", 1, index + 1);
    }
    normalized.add(key);
  }

  const rows: TabularRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (row.cellCount > options.maxColumns) {
      throw importError(
        "column_limit_exceeded",
        "A planilha excede o limite de colunas.",
        rowNumber,
      );
    }
    const cells = Array.from({ length: headerWidth }, (_, index) => {
      const cell = row.getCell(index + 1);
      const text = cellValueToText(cell.value, options.locale, rowNumber, index + 1);
      if (encoder.encode(text).byteLength > options.maxCellBytes) {
        throw importError(
          "cell_too_large",
          "Uma célula excede o limite permitido.",
          rowNumber,
          index + 1,
        );
      }
      return text;
    });
    rows.push({ rowNumber, cells });
  }
  while (rows.length > 0) {
    const lastRow = rows.at(-1);
    if (lastRow === undefined || !rowIsEmpty(lastRow)) break;
    rows.pop();
  }
  return { headers, rows };
}

/** Parses one bounded, visible XLSX worksheet without evaluating workbook content. */
export async function parseXlsx(
  input: Uint8Array,
  options: XlsxParserOptions = {},
): Promise<ParsedXlsx> {
  if (!(input instanceof Uint8Array)) throw new TypeError("input must be a Uint8Array");
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_XLSX_LIMITS.maxBytes, "maxBytes");
  const maxRows = positiveLimit(options.maxRows, DEFAULT_XLSX_LIMITS.maxRows, "maxRows");
  const maxColumns = positiveLimit(
    options.maxColumns,
    DEFAULT_XLSX_LIMITS.maxColumns,
    "maxColumns",
  );
  const maxCellBytes = positiveLimit(
    options.maxCellBytes,
    DEFAULT_XLSX_LIMITS.maxCellBytes,
    "maxCellBytes",
  );
  const maxUncompressedBytes = positiveLimit(
    options.maxUncompressedBytes,
    DEFAULT_XLSX_LIMITS.maxUncompressedBytes,
    "maxUncompressedBytes",
  );
  if (input.byteLength > maxBytes) {
    throw importError("file_too_large", "O arquivo excede o limite configurado.");
  }
  inspectXlsxContainer(input, maxUncompressedBytes);

  let workbook: ExcelJS.Workbook;
  try {
    const loader = new ExcelJS.Workbook();
    const buffer = Buffer.from(input) as unknown as Parameters<typeof loader.xlsx.load>[0];
    workbook = await loader.xlsx.load(buffer);
  } catch {
    throw importError("invalid_xlsx", "O arquivo XLSX não pôde ser lido com segurança.");
  }
  const selected = selectWorksheet(workbook, options);
  const parsed = readWorksheet(selected.worksheet, {
    maxRows,
    maxColumns,
    maxCellBytes,
    locale: options.locale,
  });
  return {
    ...parsed,
    format: "xlsx",
    sheetName: selected.worksheet.name,
    sheetIndex: selected.index,
    byteLength: input.byteLength,
  };
}
