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
