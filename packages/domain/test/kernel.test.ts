import { describe, expect, it } from "vitest";

import {
  addLocalDateDays,
  allocateMoney,
  andThen,
  createCorrelationId,
  createUuidV7,
  DomainError,
  err,
  fixedClock,
  isErr,
  isOk,
  moneyFromCommandMinor,
  moneyFromDerivedMinor,
  nowInstant,
  ok,
  parseCorrelationId,
  parseInstant,
  parseLocalDate,
  parseMoneyJson,
  parseTimeZone,
  parseUserId,
  parseWorkspaceId,
  todayInTimeZone,
} from "../src/index.js";

describe("IDs opacos e canônicos", () => {
  it("gera UUIDv7 lowercase e aceita somente a versão/variante esperadas", () => {
    const generated = createUuidV7();
    const parsed = parseWorkspaceId(generated);

    expect(isOk(parsed)).toBe(true);
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(parseWorkspaceId(generated.toUpperCase())).toMatchObject({ ok: false });
    expect(parseWorkspaceId("550e8400-e29b-41d4-a716-446655440000")).toMatchObject({ ok: false });
  });

  it("não trata UserId Better Auth como UUID de domínio", () => {
    const user = parseUserId("better-auth-user_123");
    const workspace = parseWorkspaceId(createUuidV7());

    expect(user).toMatchObject({ ok: true });
    expect(workspace).toMatchObject({ ok: true });
    expect(parseUserId("")).toMatchObject({ ok: false });
  });

  it("gera e valida CorrelationId como ULID uppercase", () => {
    const id = createCorrelationId();

    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(parseCorrelationId(id)).toMatchObject({ ok: true });
    expect(parseCorrelationId(id.toLowerCase())).toMatchObject({ ok: false });
  });
});

describe("Money em minor units", () => {
  it("faz round trip canônico sem passar por number", () => {
    const money = moneyFromDerivedMinor("999999999999999", "BRL");

    expect(money).toMatchObject({ ok: true });
    if (isOk(money)) {
      expect(money.value.minor).toBe(999999999999999n);
      expect(money.value.toJSON()).toEqual({ currency: "BRL", minor: "999999999999999" });
    }
  });

  it("aceita comando somente positivo e rejeita number/float", () => {
    expect(moneyFromCommandMinor("1", "BRL")).toMatchObject({ ok: true });
    expect(moneyFromCommandMinor("0", "BRL")).toMatchObject({ ok: false });
    expect(moneyFromCommandMinor("-1", "BRL")).toMatchObject({ ok: false });
    expect(moneyFromCommandMinor(1.5, "BRL")).toMatchObject({ ok: false });
    expect(moneyFromCommandMinor(1, "BRL")).toMatchObject({ ok: false });
  });

  it("conserva a soma em uma propriedade de operações e em largest remainder", () => {
    for (let left = -100; left <= 100; left += 1) {
      for (let right = -100; right <= 100; right += 1) {
        const a = moneyFromDerivedMinor(String(left), "BRL");
        const b = moneyFromDerivedMinor(String(right), "BRL");
        expect(a).toMatchObject({ ok: true });
        expect(b).toMatchObject({ ok: true });
        if (isOk(a) && isOk(b)) {
          const sum = a.value.add(b.value);
          expect(sum).toMatchObject({ ok: true });
          if (isOk(sum)) expect(sum.value.minor).toBe(BigInt(left + right));
        }
      }
    }

    const money = moneyFromDerivedMinor("10", "BRL");
    expect(money).toMatchObject({ ok: true });
    if (isOk(money)) {
      const pieces = allocateMoney(money.value, [1n, 1n, 1n]);
      expect(pieces).toMatchObject({ ok: true });
      if (isOk(pieces)) expect(pieces.value.map((part) => part.minor)).toEqual([4n, 3n, 3n]);
    }
  });

  it("rejeita moeda incompatível e JSON não canônico", () => {
    const brl = moneyFromDerivedMinor("10", "BRL");
    const usd = moneyFromDerivedMinor("1", "USD");
    expect(brl).toMatchObject({ ok: true });
    expect(usd).toMatchObject({ ok: true });
    if (isOk(brl) && isOk(usd)) expect(brl.value.add(usd.value)).toMatchObject({ ok: false });
    expect(parseMoneyJson({ currency: "BRL", minor: "01" })).toMatchObject({ ok: false });
    expect(parseMoneyJson({ currency: "BRL", minor: 10 })).toMatchObject({ ok: false });
  });
});

describe("datas civis, fuso e relógio", () => {
  it("valida LocalDate real sem converter para meia-noite UTC", () => {
    const leap = parseLocalDate("2024-02-29");
    expect(leap).toMatchObject({ ok: true });
    expect(parseLocalDate("2023-02-29")).toMatchObject({ ok: false });
    expect(parseLocalDate("2024-2-09")).toMatchObject({ ok: false });
    if (isOk(leap)) expect(addLocalDateDays(leap.value, 1)).toBe("2024-03-01");
  });

  it("faz aritmética civil correta para anos de quatro dígitos baixos e limita o domínio", () => {
    const first = parseLocalDate("0001-01-01");
    const ninetyNine = parseLocalDate("0099-12-31");
    const last = parseLocalDate("9999-12-31");

    expect(first).toMatchObject({ ok: true });
    expect(ninetyNine).toMatchObject({ ok: true });
    expect(last).toMatchObject({ ok: true });
    if (isOk(first) && isOk(ninetyNine) && isOk(last)) {
      expect(addLocalDateDays(first.value, 1)).toBe("0001-01-02");
      expect(addLocalDateDays(ninetyNine.value, 1)).toBe("0100-01-01");
      expect(() => addLocalDateDays(first.value, -1)).toThrow(RangeError);
      expect(() => addLocalDateDays(last.value, 1)).toThrow(RangeError);
    }
  });

  it("valida nomes IANA e rejeita offsets persistidos", () => {
    expect(parseTimeZone("America/Sao_Paulo")).toMatchObject({ ok: true });
    expect(parseTimeZone("-03:00")).toMatchObject({ ok: false });
    expect(parseTimeZone("not/a-timezone")).toMatchObject({ ok: false });
  });

  it("deriva hoje a partir do relógio injetado e preserva instante UTC", () => {
    const clock = fixedClock(new Date("2024-03-01T02:30:00.123Z"));
    const zone = parseTimeZone("America/Sao_Paulo");
    expect(zone).toMatchObject({ ok: true });
    expect(parseInstant("2024-03-01T02:30:00.123Z")).toMatchObject({ ok: true });
    expect(nowInstant(clock)).toBe("2024-03-01T02:30:00.123Z");
    if (isOk(zone)) {
      const today = todayInTimeZone(clock, zone.value);
      expect(today).toMatchObject({ ok: true, value: "2024-02-29" });
    }
  });
});

describe("Result e erros seguros", () => {
  it("compõe sucesso/falha sem lançar e não serializa stack", () => {
    const result = andThen(ok(2), (value) =>
      value > 1 ? ok(value * 2) : err(new DomainError("validation_failed", "inválido")),
    );
    expect(result).toEqual({ ok: true, value: 4 });

    const failure = err(
      new DomainError("validation_failed", "Revise o campo.", { amount: ["Inválido"] }),
    );
    expect(isErr(failure)).toBe(true);
    if (isErr(failure)) {
      expect(failure.error.toJSON()).toEqual({
        code: "validation_failed",
        message: "Revise o campo.",
        fieldErrors: { amount: ["Inválido"] },
      });
      expect(failure.error.toJSON()).not.toHaveProperty("stack");
    }
  });
});
