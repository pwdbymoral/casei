import { DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type LocalDate = string & { readonly __localDate: unique symbol };
export type Instant = string & { readonly __instant: unique symbol };
export type TimeZone = string & { readonly __timeZone: unique symbol };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseLocalDate(value: unknown): Result<LocalDate, DomainError> {
  if (typeof value !== "string") {
    return err(new DomainError("invalid_local_date", "A data deve usar o formato YYYY-MM-DD."));
  }
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) {
    return err(new DomainError("invalid_local_date", "A data deve usar o formato YYYY-MM-DD."));
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return err(new DomainError("invalid_local_date", "A data civil não existe."));
  }
  return ok(value as LocalDate);
}

export function addLocalDateDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) throw new RangeError("days must be a safe integer");
  const parsed = parseLocalDate(date);
  if (!parsed.ok) throw new RangeError("date must be a valid LocalDate");
  const [yearText, monthText, dayText] = date.split("-");
  const dateAtUtc = new Date(0);
  dateAtUtc.setUTCHours(0, 0, 0, 0);
  dateAtUtc.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  dateAtUtc.setUTCDate(dateAtUtc.getUTCDate() + days);
  const resultYear = dateAtUtc.getUTCFullYear();
  if (resultYear < 1 || resultYear > 9999) {
    throw new RangeError("LocalDate result must stay within years 0001-9999");
  }
  const result = `${resultYear.toString().padStart(4, "0")}-${(dateAtUtc.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${dateAtUtc.getUTCDate().toString().padStart(2, "0")}`;
  const parsedResult = parseLocalDate(result);
  if (!parsedResult.ok) throw new RangeError("LocalDate result must be a real civil date");
  return parsedResult.value;
}

/** Adds civil calendar months and clamps an invalid target day to month end. */
export function addLocalDateMonths(date: LocalDate, months: number): LocalDate {
  if (!Number.isSafeInteger(months)) throw new RangeError("months must be a safe integer");
  const parsed = parseLocalDate(date);
  if (!parsed.ok) throw new RangeError("date must be a valid LocalDate");
  const [yearText, monthText, dayText] = date.split("-");
  // Date.UTC treats years 0–99 as 1900–1999. setUTCFullYear preserves the
  // proleptic Gregorian year represented by a LocalDate instead.
  const target = new Date(0);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCFullYear(Number(yearText), Number(monthText) - 1 + months, 1);
  const targetYear = target.getUTCFullYear();
  if (targetYear < 1 || targetYear > 9999) {
    throw new RangeError("LocalDate result must stay within years 0001-9999");
  }
  const targetMonth = target.getUTCMonth() + 1;
  const lastDayDate = new Date(0);
  lastDayDate.setUTCHours(0, 0, 0, 0);
  lastDayDate.setUTCFullYear(targetYear, targetMonth, 0);
  const lastDay = lastDayDate.getUTCDate();
  const result = `${targetYear.toString().padStart(4, "0")}-${targetMonth
    .toString()
    .padStart(2, "0")}-${Math.min(Number(dayText), lastDay).toString().padStart(2, "0")}`;
  const parsedResult = parseLocalDate(result);
  if (!parsedResult.ok) throw new RangeError("LocalDate result must be a real civil date");
  return parsedResult.value;
}

export function parseInstant(value: unknown): Result<Instant, DomainError> {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) {
    return err(
      new DomainError("invalid_instant", "O instante deve ser ISO 8601 UTC com milissegundos."),
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    return err(new DomainError("invalid_instant", "O instante não existe."));
  }
  return ok(value as Instant);
}

export function parseTimeZone(value: unknown): Result<TimeZone, DomainError> {
  if (typeof value !== "string" || value.length === 0 || value.includes(":")) {
    return err(new DomainError("invalid_time_zone", "O fuso deve ser um nome IANA."));
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return ok(value as TimeZone);
  } catch {
    return err(new DomainError("invalid_time_zone", "O fuso deve ser um nome IANA."));
  }
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(value: Date | Instant): Clock {
  const fixed = new Date(value);
  if (Number.isNaN(fixed.getTime())) throw new RangeError("fixed clock requires a valid instant");
  return {
    now: () => new Date(fixed.getTime()),
  };
}

export function nowInstant(clock: Clock = systemClock): Instant {
  const value = clock.now().toISOString();
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new RangeError("clock returned an invalid date");
  return parsed.value;
}

export function todayInTimeZone(clock: Clock, timeZone: TimeZone): Result<LocalDate, DomainError> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(clock.now());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return parseLocalDate(`${values.year}-${values.month}-${values.day}`);
}
