import { describe, expect, it } from "vitest";

import { caretPositionAfterFormatting, formatMoneyMinor, parseMoneyInput } from "./money";

describe("money UI boundary", () => {
  it("converts localized digits and paste into canonical minor units", () => {
    expect(parseMoneyInput("R$ 1.234,56")).toBe("123456");
    expect(parseMoneyInput("  80,00 ")).toBe("8000");
    expect(parseMoneyInput("abc")).toBe("0");
  });

  it("limits the input to the contract's 15 minor-unit digits", () => {
    expect(parseMoneyInput("99999999999999999")).toBe("999999999999999");
  });

  it("formats the canonical value for pt-BR without losing cents", () => {
    expect(formatMoneyMinor("123456")).toBe("R$ 1.234,56");
  });

  it("uses the workspace currency instead of assuming BRL", () => {
    expect(formatMoneyMinor("123456", "USD", "en-US")).toBe("$1,234.56");
  });

  it("keeps the caret after the same digit when formatting changes", () => {
    const formatted = formatMoneyMinor("123456");
    expect(caretPositionAfterFormatting(formatted, 4)).toBe(formatted.indexOf("4") + 1);
  });
});
