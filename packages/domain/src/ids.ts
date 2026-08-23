import { DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

declare const idBrand: unique symbol;
type OpaqueId<Name extends string> = string & { readonly [idBrand]: Name };

export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type TransactionId = OpaqueId<"TransactionId">;
export type GoalId = OpaqueId<"GoalId">;
export type UserId = OpaqueId<"UserId">;
export type CorrelationId = OpaqueId<"CorrelationId">;
export type UuidV7 = OpaqueId<"UuidV7">;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function invalidId(message: string): Result<never, DomainError> {
  return err(new DomainError("invalid_id", message));
}

function parseUuidV7Value<T extends string>(value: unknown): Result<T, DomainError> {
  return typeof value === "string" && UUID_V7_PATTERN.test(value)
    ? ok(value as T)
    : invalidId("O identificador deve ser um UUIDv7 em lowercase.");
}

export function createUuidV7(at = Date.now()): UuidV7 {
  if (!Number.isSafeInteger(at) || at < 0 || at >= 2 ** 48) {
    throw new RangeError("UUIDv7 timestamp must be a non-negative safe integer within 48 bits");
  }

  const bytes = secureRandomBytes(16);
  let timestamp = BigInt(at);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UuidV7;
}

export function parseUuidV7(value: unknown): Result<UuidV7, DomainError> {
  return parseUuidV7Value<UuidV7>(value);
}

export function parseWorkspaceId(value: unknown): Result<WorkspaceId, DomainError> {
  return parseUuidV7Value<WorkspaceId>(value);
}

export function parseTransactionId(value: unknown): Result<TransactionId, DomainError> {
  return parseUuidV7Value<TransactionId>(value);
}

export function parseGoalId(value: unknown): Result<GoalId, DomainError> {
  return parseUuidV7Value<GoalId>(value);
}

export function parseUserId(value: unknown): Result<UserId, DomainError> {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    return err(new DomainError("invalid_user_id", "O identificador de usuário é obrigatório."));
  }
  return ok(value as UserId);
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

export function createCorrelationId(at = Date.now()): CorrelationId {
  if (!Number.isSafeInteger(at) || at < 0 || at >= 2 ** 48) {
    throw new RangeError("ULID timestamp must be a non-negative safe integer within 48 bits");
  }
  const timestamp = encodeBase32(BigInt(at), 10);
  const entropy = bytesToBigInt(secureRandomBytes(10));
  return `${timestamp}${encodeBase32(entropy, 16)}` as CorrelationId;
}

export function parseCorrelationId(value: unknown): Result<CorrelationId, DomainError> {
  return typeof value === "string" && ULID_PATTERN.test(value)
    ? ok(value as CorrelationId)
    : err(new DomainError("invalid_correlation_id", "A correlação deve ser um ULID uppercase."));
}
