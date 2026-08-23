const MAX_MINOR_DIGITS = 15;

export function formatMoneyMinor(minor: string, currency = "BRL", locale = "pt-BR"): string {
  const parsed = BigInt(minor || "0");
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(parsed) / 100);
}

/** Converts localized typed/pasted money into the canonical minor-unit string. */
export function parseMoneyInput(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, MAX_MINOR_DIGITS);
  return digits.replace(/^0+(?=\d)/, "") || "0";
}

/** Finds the visual caret location after reformatting while preserving digit intent. */
export function caretPositionAfterFormatting(formatted: string, digitsBeforeCaret: number): number {
  if (digitsBeforeCaret <= 0) return 0;
  let digitsSeen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index] ?? "")) {
      digitsSeen += 1;
      if (digitsSeen >= digitsBeforeCaret) return index + 1;
    }
  }
  return formatted.length;
}
