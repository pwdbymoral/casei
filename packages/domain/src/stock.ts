export type StockMovementKind = "entry" | "consume" | "correction" | "discard";
export type StockState = "unknown" | "ok" | "low" | "missing";

const MAX_QUANTITY_MILLI = 999_999_999_999_999n;

/** Collapses user-entered whitespace and creates the accent/case-insensitive key used by stock. */
export function normalizeProductName(name: string): { display: string; key: string } {
  const display = name.trim().replace(/\s+/gu, " ");
  const key = display
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
  return { display, key };
}

/** Parses the transport quantity into a fixed-point milli-unit without using floating point. */
export function parseStockQuantity(value: string, options: { allowZero?: boolean } = {}): bigint {
  const source = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(source)) {
    throw new RangeError("Quantidade deve usar até três casas decimais.");
  }
  const [whole = "0", fraction = ""] = source.split(".");
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0") || "0");
  if (!options.allowZero && milli <= 0n)
    throw new RangeError("Quantidade deve ser maior que zero.");
  if (milli < 0n || milli > MAX_QUANTITY_MILLI) throw new RangeError("Quantidade fora do limite.");
  return milli;
}

export function formatStockQuantity(milli: bigint | null): string | null {
  if (milli === null) return null;
  if (milli < 0n || milli > MAX_QUANTITY_MILLI) throw new RangeError("Quantidade fora do limite.");
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function deriveStockState(input: {
  quantityMilli: bigint | null;
  minimumMilli: bigint | null;
  markedMissing: boolean;
}): StockState {
  if (input.markedMissing || input.quantityMilli === 0n) return "missing";
  if (input.quantityMilli === null) return "unknown";
  if (input.minimumMilli !== null && input.quantityMilli <= input.minimumMilli) return "low";
  return "ok";
}

/** Returns the amount needed to reach the desired minimum, or null when no minimum exists. */
export function suggestedShoppingQuantity(input: {
  quantityMilli: bigint | null;
  minimumMilli: bigint | null;
}): bigint | null {
  if (input.minimumMilli === null) return null;
  const quantityMilli = input.quantityMilli ?? 0n;
  return input.minimumMilli > quantityMilli ? input.minimumMilli - quantityMilli : 0n;
}

/** Automatic shopping entries are derived from the same state shown by the stock card. */
export function shouldAutoAddToShopping(input: {
  quantityMilli: bigint | null;
  minimumMilli: bigint | null;
  markedMissing: boolean;
  shoppingAuto?: boolean;
}): boolean {
  return (
    (input.shoppingAuto ?? true) &&
    (input.markedMissing ||
      input.quantityMilli === 0n ||
      (input.quantityMilli !== null &&
        input.minimumMilli !== null &&
        input.quantityMilli <= input.minimumMilli))
  );
}

export function stockMovementAfter(input: {
  kind: StockMovementKind;
  beforeMilli: bigint | null;
  quantityMilli: bigint;
}): bigint {
  if (input.quantityMilli < 0n) throw new RangeError("Quantidade não pode ser negativa.");
  if (input.kind === "correction") {
    if (input.quantityMilli > MAX_QUANTITY_MILLI)
      throw new RangeError("Quantidade fora do limite.");
    return input.quantityMilli;
  }
  const before = input.beforeMilli ?? 0n;
  const after =
    input.kind === "entry" ? before + input.quantityMilli : before - input.quantityMilli;
  if (after < 0n) throw new RangeError("O consumo não pode deixar o estoque negativo.");
  if (after > MAX_QUANTITY_MILLI) throw new RangeError("Quantidade fora do limite.");
  return after;
}
