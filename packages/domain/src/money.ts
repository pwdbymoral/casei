import { DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export const MAX_MONEY_MINOR = 999999999999999n;
const MINOR_PATTERN = /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type CurrencyCode = string & { readonly __currencyCode: unique symbol };

function parseCurrency(value: unknown): Result<CurrencyCode, DomainError> {
  if (typeof value !== "string" || !CURRENCY_PATTERN.test(value)) {
    return err(
      new DomainError("invalid_money", "A moeda deve usar um código ISO uppercase de três letras."),
    );
  }
  return ok(value as CurrencyCode);
}

function parseMinor(value: unknown): Result<bigint, DomainError> {
  if (typeof value !== "string" || !MINOR_PATTERN.test(value)) {
    return err(
      new DomainError("invalid_money", "minor deve ser uma string decimal inteira canônica."),
    );
  }
  if (value === "-0")
    return err(new DomainError("invalid_money", "minor não pode representar zero negativo."));
  return ok(BigInt(value));
}

function withinRange(value: bigint): boolean {
  return value >= -MAX_MONEY_MINOR && value <= MAX_MONEY_MINOR;
}

function createMoney(minor: bigint, currency: CurrencyCode): Money {
  return Money.fromTrusted(minor, currency);
}

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {}

  /** Construtor interno usado somente depois da validação dos value objects. */
  static fromTrusted(minor: bigint, currency: CurrencyCode): Money {
    return new Money(minor, currency);
  }

  add(other: Money): Result<Money, DomainError> {
    if (this.currency !== other.currency) {
      return err(
        new DomainError("currency_mismatch", "Não é possível somar valores de moedas diferentes."),
      );
    }
    const result = this.minor + other.minor;
    return withinRange(result)
      ? ok(createMoney(result, this.currency))
      : err(
          new DomainError("money_out_of_range", "O resultado monetário excede o limite permitido."),
        );
  }

  subtract(other: Money): Result<Money, DomainError> {
    if (this.currency !== other.currency) {
      return err(
        new DomainError(
          "currency_mismatch",
          "Não é possível subtrair valores de moedas diferentes.",
        ),
      );
    }
    const result = this.minor - other.minor;
    return withinRange(result)
      ? ok(createMoney(result, this.currency))
      : err(
          new DomainError("money_out_of_range", "O resultado monetário excede o limite permitido."),
        );
  }

  negate(): Result<Money, DomainError> {
    return ok(createMoney(-this.minor, this.currency));
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): { currency: string; minor: string } {
    return { currency: this.currency, minor: this.minor.toString() };
  }
}

function moneyFromMinor(
  value: unknown,
  currency: unknown,
  positiveOnly: boolean,
): Result<Money, DomainError> {
  const parsedCurrency = parseCurrency(currency);
  if (!parsedCurrency.ok) return parsedCurrency;
  const parsedMinor = parseMinor(value);
  if (!parsedMinor.ok) return parsedMinor;

  if (!withinRange(parsedMinor.value) || (positiveOnly && parsedMinor.value <= 0)) {
    return err(
      new DomainError(
        positiveOnly ? "validation_failed" : "money_out_of_range",
        positiveOnly
          ? "O valor deve ser positivo e estar dentro do limite permitido."
          : "O valor monetário está fora do limite permitido.",
      ),
    );
  }
  return ok(createMoney(parsedMinor.value, parsedCurrency.value));
}

export function moneyFromCommandMinor(
  value: unknown,
  currency: unknown,
): Result<Money, DomainError> {
  return moneyFromMinor(value, currency, true);
}

export function moneyFromDerivedMinor(
  value: unknown,
  currency: unknown,
): Result<Money, DomainError> {
  return moneyFromMinor(value, currency, false);
}

export function parseMoneyJson(value: unknown): Result<Money, DomainError> {
  if (value === null || typeof value !== "object") {
    return err(new DomainError("invalid_money", "O valor monetário deve ser um objeto."));
  }
  const record = value as Record<string, unknown>;
  return moneyFromDerivedMinor(record.minor, record.currency);
}

export function allocateMoney(
  money: Money,
  weights: readonly bigint[],
): Result<readonly Money[], DomainError> {
  if (weights.length === 0 || weights.some((weight) => weight < 0n)) {
    return err(new DomainError("invalid_allocation", "A divisão precisa de pesos não negativos."));
  }
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    return err(
      new DomainError("invalid_allocation", "A divisão precisa de ao menos um peso positivo."),
    );
  }

  const sign = money.minor < 0n ? -1n : 1n;
  const absolute = money.minor < 0n ? -money.minor : money.minor;
  const bases = weights.map((weight) => (absolute * weight) / totalWeight);
  const remainders = weights.map((weight) => (absolute * weight) % totalWeight);
  let remaining = absolute - bases.reduce((sum, part) => sum + part, 0n);
  const order = weights
    .map((_, index) => index)
    .sort((left, right) => {
      const difference = (remainders[right] ?? 0n) - (remainders[left] ?? 0n);
      if (difference > 0n) return 1;
      if (difference < 0n) return -1;
      return left - right;
    });
  const portions = [...bases];
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    const target = order[index];
    if (target === undefined) {
      return err(new DomainError("invalid_allocation", "Não foi possível distribuir o valor."));
    }
    portions[target] = (portions[target] ?? 0n) + 1n;
  }
  return ok(portions.map((portion) => createMoney(sign * portion, money.currency)));
}
