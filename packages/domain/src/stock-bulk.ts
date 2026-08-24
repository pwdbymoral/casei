import {
  formatStockQuantity,
  normalizeProductName,
  parseStockQuantity,
  type StockUnit,
} from "./stock.js";

export const DEFAULT_STOCK_BULK_LIMITS = Object.freeze({
  maxBytes: 10_000_000,
  maxRows: 50_000,
});

export type StockBulkMode = "valid_only" | "all_or_nothing";

export interface StockBulkProductValues {
  readonly name: string;
  readonly unit?: StockUnit;
  readonly unitLabel?: string;
  readonly quantity?: string;
  readonly minimum?: string;
  readonly shoppingAuto?: boolean;
  readonly markedMissing?: boolean;
  readonly category?: string;
  readonly location?: string;
  readonly note?: string;
}

export interface StockBulkParsedRow {
  readonly lineNumber: number;
  readonly values: StockBulkProductValues;
  readonly errors: readonly string[];
}

export interface StockBulkDocument {
  readonly headers: readonly string[];
  readonly rows: readonly StockBulkParsedRow[];
  readonly fatalErrors: readonly string[];
}

export interface StockBulkExistingProduct {
  readonly id: string;
  readonly name: string;
  readonly unit: StockUnit;
  readonly unitLabel: string | null;
  readonly quantity: string | null;
  readonly minimum: string | null;
  readonly markedMissing: boolean;
  readonly shoppingAuto: boolean;
  readonly category: string | null;
  readonly location: string | null;
  readonly note: string | null;
  readonly version: number;
  readonly hasMovement: boolean;
}

export type StockBulkRowStatus = "new" | "update" | "duplicate" | "invalid";

export interface StockBulkChange {
  readonly field: string;
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
}

export interface StockBulkPreviewRow {
  readonly lineNumber: number;
  readonly status: StockBulkRowStatus;
  readonly name: string;
  readonly existingProductId?: string;
  readonly values?: StockBulkProductValues;
  readonly changes: readonly StockBulkChange[];
  readonly errors: readonly string[];
}

export interface StockBulkPreview {
  readonly headers: readonly string[];
  readonly fatalErrors: readonly string[];
  readonly rows: readonly StockBulkPreviewRow[];
  readonly counts: {
    readonly new: number;
    readonly update: number;
    readonly duplicate: number;
    readonly invalid: number;
  };
  readonly canApplyValidOnly: boolean;
  readonly canApplyAllOrNothing: boolean;
}

type BulkField = Exclude<keyof StockBulkProductValues, "name">;
type ComparableValue = string | boolean | null;

const HEADER_ALIASES: Readonly<Record<keyof StockBulkProductValues, readonly string[]>> = {
  name: ["nome", "produto", "name", "product"],
  unit: ["unidade", "unit"],
  unitLabel: ["rotulo unidade", "rotulo", "unit label", "unitlabel"],
  quantity: ["quantidade", "quantity", "estoque", "quantidade atual"],
  minimum: ["minimo", "minimum", "minimo desejado", "estoque minimo"],
  shoppingAuto: ["comprar automaticamente", "compra automatica", "shopping auto", "shoppingauto"],
  markedMissing: ["faltando", "marcado faltando", "marked missing", "markedmissing"],
  category: ["categoria", "category"],
  location: ["local", "location"],
  note: ["nota", "observacao", "observacao", "note"],
};

const TEXT_LIMITS: Readonly<
  Record<Exclude<keyof StockBulkProductValues, "unit" | "shoppingAuto" | "markedMissing">, number>
> = {
  name: 200,
  unitLabel: 40,
  quantity: 40,
  minimum: 40,
  category: 100,
  location: 100,
  note: 500,
};

const BULK_FIELDS: readonly BulkField[] = [
  "unit",
  "unitLabel",
  "quantity",
  "minimum",
  "shoppingAuto",
  "markedMissing",
  "category",
  "location",
  "note",
];

const UNIT_ALIASES: Readonly<Record<string, StockUnit>> = {
  unit: "unit",
  unidade: "unit",
  un: "unit",
  package: "package",
  pacote: "package",
  pacotes: "package",
  box: "box",
  caixa: "box",
  caixas: "box",
  kg: "kg",
  g: "g",
  l: "L",
  litro: "L",
  litros: "L",
  ml: "ml",
  other: "other",
  outra: "other",
  outro: "other",
};

function normalizeBulkHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function splitPhysicalLines(content: string): string[] {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function splitDelimitedLine(
  line: string,
  delimiter: "\t" | ";",
): {
  cells: string[];
  error?: string;
} {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let justClosedQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell !== "" || justClosedQuote) return { cells, error: "Aspas malformadas." };
      inQuotes = true;
      continue;
    }
    if (justClosedQuote && character !== delimiter) {
      return { cells, error: "Uma célula entre aspas deve terminar no separador." };
    }
    if (character === delimiter) {
      cells.push(cell);
      cell = "";
      justClosedQuote = false;
      continue;
    }
    cell += character;
    justClosedQuote = false;
  }
  if (inQuotes) return { cells, error: "Uma célula entre aspas não foi fechada." };
  cells.push(cell);
  return { cells };
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = normalizeBulkHeader(value);
  if (["true", "sim", "yes", "1"].includes(normalized)) return true;
  if (["false", "nao", "no", "0"].includes(normalized)) return false;
  return undefined;
}

function parseUnit(value: string): StockUnit | undefined {
  return UNIT_ALIASES[normalizeBulkHeader(value)];
}

function parseQuantity(value: string): string | undefined {
  try {
    return formatStockQuantity(parseStockQuantity(value, { allowZero: true })) ?? undefined;
  } catch {
    return undefined;
  }
}

function mapHeader(header: string): keyof StockBulkProductValues | undefined {
  const normalized = normalizeBulkHeader(header);
  for (const key of Object.keys(HEADER_ALIASES) as (keyof StockBulkProductValues)[]) {
    if (HEADER_ALIASES[key].includes(normalized)) return key;
  }
  return undefined;
}

function parseRow(
  line: string,
  lineNumber: number,
  delimiter: "\t" | ";",
  headerMap: readonly (keyof StockBulkProductValues | undefined)[],
): StockBulkParsedRow {
  const split = splitDelimitedLine(line, delimiter);
  const errors: string[] = split.error ? [split.error] : [];
  const nameIndex = headerMap.indexOf("name");
  const rawName = split.cells[nameIndex < 0 ? 0 : nameIndex] ?? "";
  const values: StockBulkProductValues = { name: normalizeText(rawName) };
  const mutable = values as unknown as Record<string, unknown>;
  for (const [index, key] of headerMap.entries()) {
    if (key === undefined || key === "name") continue;
    const raw = normalizeText(split.cells[index] ?? "");
    if (raw === "") continue;
    if (key === "unit") {
      const unit = parseUnit(raw);
      if (unit === undefined) errors.push(`Unidade inválida: ${raw}.`);
      else mutable[key] = unit;
      continue;
    }
    if (key === "shoppingAuto" || key === "markedMissing") {
      const boolean = parseBoolean(raw);
      if (boolean === undefined) errors.push(`Valor booleano inválido: ${raw}.`);
      else mutable[key] = boolean;
      continue;
    }
    if (key === "quantity" || key === "minimum") {
      const quantity = parseQuantity(raw);
      if (quantity === undefined) errors.push(`Quantidade inválida: ${raw}.`);
      else mutable[key] = quantity;
      continue;
    }
    const limit = TEXT_LIMITS[key];
    if (raw.length > limit) errors.push(`O campo ${key} excede ${limit} caracteres.`);
    else mutable[key] = raw;
  }
  for (const key of BULK_FIELDS) {
    if (key === "unit" && mutable[key] === "other" && !mutable.unitLabel) {
      errors.push("Informe o rótulo quando a unidade for outra.");
    }
  }
  if (split.cells.length > headerMap.length) errors.push("A linha possui colunas extras.");
  return { lineNumber, values, errors };
}

/** Parses one-name-per-line input or tab/semicolon-delimited paste. */
export function parseStockBulk(content: string): StockBulkDocument {
  if (typeof content !== "string") {
    return { headers: [], rows: [], fatalErrors: ["O conteúdo do lote é inválido."] };
  }
  if (new TextEncoder().encode(content).byteLength > DEFAULT_STOCK_BULK_LIMITS.maxBytes) {
    return { headers: [], rows: [], fatalErrors: ["O conteúdo excede o limite permitido."] };
  }
  const lines = splitPhysicalLines(content);
  if (lines.length > DEFAULT_STOCK_BULK_LIMITS.maxRows) {
    return { headers: [], rows: [], fatalErrors: ["O lote excede o limite de linhas."] };
  }
  const first = lines[0] ?? "";
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : undefined;
  if (delimiter === undefined) {
    return {
      headers: [],
      rows: lines.map((line, index) => ({
        lineNumber: index + 1,
        values: { name: normalizeText(line) },
        errors: [],
      })),
      fatalErrors: [],
    };
  }

  const headerSplit = splitDelimitedLine(first, delimiter);
  if (headerSplit.error) return { headers: [], rows: [], fatalErrors: [headerSplit.error] };
  const headers = headerSplit.cells.map((header) => header.trim());
  const headerMap: (keyof StockBulkProductValues | undefined)[] = [];
  const seenHeaders = new Set<string>();
  const headerErrors: string[] = [];
  for (const header of headers) {
    const normalized = normalizeBulkHeader(header);
    const key = mapHeader(header);
    if (normalized === "" || key === undefined) {
      headerErrors.push(`Cabeçalho desconhecido: ${header || "(vazio)"}.`);
      headerMap.push(undefined);
      continue;
    }
    if (seenHeaders.has(key)) headerErrors.push(`Cabeçalho duplicado: ${header}.`);
    seenHeaders.add(key);
    headerMap.push(key);
  }
  if (!seenHeaders.has("name")) headerErrors.push("O cabeçalho precisa conter Nome.");
  if (headerErrors.length > 0) return { headers, rows: [], fatalErrors: headerErrors };

  return {
    headers,
    rows: lines.slice(1).map((line, index) => parseRow(line, index + 2, delimiter, headerMap)),
    fatalErrors: [],
  };
}

function valueForField(
  values: StockBulkProductValues,
  field: BulkField,
): ComparableValue | undefined {
  const value = values[field];
  return value === undefined ? undefined : value;
}

function existingValueForField(
  existing: StockBulkExistingProduct,
  field: keyof StockBulkProductValues,
): ComparableValue {
  if (field === "name") return existing.name;
  return existing[field] as ComparableValue;
}

function addChange(
  changes: StockBulkChange[],
  field: keyof StockBulkProductValues,
  before: ComparableValue,
  after: ComparableValue,
): void {
  if (before !== after) changes.push({ field, before, after });
}

function previewExistingRow(
  row: StockBulkParsedRow,
  existing: StockBulkExistingProduct,
): StockBulkPreviewRow {
  const values = row.values;
  const errors = [...row.errors];
  const changes: StockBulkChange[] = [];
  if (values.unit !== undefined && values.unit !== existing.unit && existing.hasMovement) {
    errors.push("A unidade não pode mudar depois do primeiro movimento.");
  }
  addChange(changes, "name", existing.name, values.name);
  for (const field of BULK_FIELDS) {
    const value = valueForField(values, field);
    if (value !== undefined)
      addChange(changes, field, existingValueForField(existing, field), value);
  }
  if (errors.length > 0) {
    return {
      lineNumber: row.lineNumber,
      status: "invalid",
      name: values.name,
      existingProductId: existing.id,
      values,
      changes,
      errors,
    };
  }
  if (changes.length === 0) {
    return {
      lineNumber: row.lineNumber,
      status: "duplicate",
      name: values.name,
      existingProductId: existing.id,
      values,
      changes,
      errors: ["A linha duplicada não altera o produto existente."],
    };
  }
  return {
    lineNumber: row.lineNumber,
    status: "update",
    name: values.name,
    existingProductId: existing.id,
    values,
    changes,
    errors: [],
  };
}

/** Builds a no-mutation preview against the active products observed by the caller. */
export function previewStockBulk(
  content: string,
  existing: readonly StockBulkExistingProduct[],
): StockBulkPreview {
  const document = parseStockBulk(content);
  const existingByKey = new Map<string, StockBulkExistingProduct>();
  for (const product of existing)
    existingByKey.set(normalizeProductName(product.name).key, product);
  const seen = new Set<string>();
  const rows: StockBulkPreviewRow[] = [];
  for (const row of document.rows) {
    const values = row.values;
    const errors = [...row.errors];
    if (values.name === "") errors.push("O nome do produto é obrigatório.");
    const key = normalizeProductName(values.name).key;
    const current = existingByKey.get(key);
    if (errors.length > 0) {
      rows.push({
        lineNumber: row.lineNumber,
        status: "invalid",
        name: values.name,
        ...(current ? { existingProductId: current.id } : {}),
        values,
        changes: [],
        errors,
      });
      continue;
    }
    if (seen.has(key)) {
      rows.push({
        lineNumber: row.lineNumber,
        status: "duplicate",
        name: values.name,
        ...(current ? { existingProductId: current.id } : {}),
        values,
        changes: [],
        errors: ["A linha é duplicada dentro deste lote."],
      });
      continue;
    }
    seen.add(key);
    if (current) {
      rows.push(previewExistingRow(row, current));
      continue;
    }
    const changes: StockBulkChange[] = [
      { field: "name", before: null, after: values.name },
      { field: "unit", before: null, after: values.unit ?? "unit" },
    ];
    for (const field of BULK_FIELDS) {
      const value = valueForField(values, field);
      if (value !== undefined && field !== "unit")
        changes.push({ field, before: null, after: value });
    }
    if (values.unit === "other" && values.unitLabel === undefined) {
      rows.push({
        lineNumber: row.lineNumber,
        status: "invalid",
        name: values.name,
        values,
        changes,
        errors: ["Informe o rótulo quando a unidade for outra."],
      });
    } else {
      rows.push({
        lineNumber: row.lineNumber,
        status: "new",
        name: values.name,
        values,
        changes,
        errors: [],
      });
    }
  }
  const counts = {
    new: rows.filter((row) => row.status === "new").length,
    update: rows.filter((row) => row.status === "update").length,
    duplicate: rows.filter((row) => row.status === "duplicate").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
  };
  const actionable = counts.new + counts.update > 0;
  return {
    headers: document.headers,
    fatalErrors: document.fatalErrors,
    rows,
    counts,
    canApplyValidOnly: document.fatalErrors.length === 0 && actionable,
    canApplyAllOrNothing:
      document.fatalErrors.length === 0 &&
      actionable &&
      counts.invalid === 0 &&
      counts.duplicate === 0,
  };
}
