import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const DEFAULT_OBJECT_STORAGE_MAX_BYTES = 10_000_000;
export const DEFAULT_OBJECT_STORAGE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export type StoredFileFormat = "csv" | "xlsx";
export type ObjectBody =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | ReadableStream<Uint8Array>;

export interface ObjectStorageRecord {
  readonly key: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly etag: string | null;
  readonly sha256: string;
  readonly format: StoredFileFormat;
  readonly expiresAt: string;
}

export interface ObjectStorageRead extends ObjectStorageRecord {
  readonly stream: ReadableStream<Uint8Array>;
}

export interface ObjectStoragePutInput {
  readonly key: string;
  readonly body: ObjectBody;
  readonly contentLength: number;
  readonly contentType: string;
  readonly format: StoredFileFormat;
  readonly expiresAt: Date | string;
  /** Digest calculated by the preflight/source and verified while streaming. */
  readonly sha256: string;
  readonly now?: Date;
}

export interface ObjectStoragePort {
  put(input: ObjectStoragePutInput): Promise<ObjectStorageRecord>;
  head(input: { readonly key: string; readonly now?: Date }): Promise<ObjectStorageRecord>;
  get(input: { readonly key: string; readonly now?: Date }): Promise<ObjectStorageRead>;
  delete(input: { readonly key: string }): Promise<void>;
}

export interface ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  readonly maxBytes?: number;
  readonly maxTtlMs?: number;
}

export type ObjectStorageErrorCode =
  | "invalid_object"
  | "object_expired"
  | "object_not_found"
  | "storage_unavailable"
  | "scan_rejected"
  | "invalid_format";

export class ObjectStorageError extends Error {
  constructor(
    readonly code: ObjectStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

export class InvalidObjectInputError extends ObjectStorageError {
  constructor(message = "O arquivo enviado não atende aos limites de segurança.") {
    super("invalid_object", message);
    this.name = "InvalidObjectInputError";
  }
}

export class ExpiredObjectError extends ObjectStorageError {
  constructor() {
    super("object_expired", "O arquivo não está mais disponível.");
    this.name = "ExpiredObjectError";
  }
}

export class ObjectNotFoundError extends ObjectStorageError {
  constructor() {
    super("object_not_found", "O arquivo não foi encontrado.");
    this.name = "ObjectNotFoundError";
  }
}

export class ScanRejectedError extends ObjectStorageError {
  constructor(message = "O arquivo foi rejeitado pela varredura de segurança.") {
    super("scan_rejected", message);
    this.name = "ScanRejectedError";
  }
}

export class InvalidFormatError extends ObjectStorageError {
  constructor(message = "O arquivo não corresponde ao formato declarado.") {
    super("invalid_format", message);
    this.name = "InvalidFormatError";
  }
}

export interface FileScanStartInput {
  readonly format: StoredFileFormat;
  readonly contentType: string;
  readonly contentLength: number;
}

export interface FileScanResult {
  /** The default scanner validates format only; it does not claim malware-free content. */
  readonly status: "format_valid" | "rejected";
  readonly reason?: string;
  readonly format: StoredFileFormat;
}

export interface FileScanSession {
  accept(chunk: Uint8Array): Promise<void>;
  complete(): Promise<FileScanResult>;
}

export interface FileScanPort {
  start(input: FileScanStartInput): FileScanSession;
}

const csvContentTypes = new Set(["text/csv", "text/plain", "application/csv"]);
const xlsxContentTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

/**
 * Streaming, format-only validation. Malware scanning is intentionally an
 * injected port: the storage adapter never claims that a format check is an
 * antivirus verdict.
 */
export class FormatFileScanPort implements FileScanPort {
  constructor(private readonly maxBytes = DEFAULT_OBJECT_STORAGE_MAX_BYTES) {}

  start(input: FileScanStartInput): FileScanSession {
    let byteLength = 0;
    let prefix = new Uint8Array(0);
    let complete = false;

    return {
      accept: async (chunk) => {
        if (complete) throw new InvalidObjectInputError("O scanner recebeu dados após o fim.");
        byteLength += chunk.byteLength;
        if (byteLength > this.maxBytes) throw new InvalidObjectInputError();
        if (prefix.byteLength < 8) {
          const remaining = 8 - prefix.byteLength;
          const next = new Uint8Array(prefix.byteLength + Math.min(remaining, chunk.byteLength));
          next.set(prefix);
          next.set(chunk.slice(0, remaining), prefix.byteLength);
          prefix = next;
        }
        if (chunk.includes(0)) {
          throw new ScanRejectedError("O arquivo contém bytes NUL incompatíveis com o formato.");
        }
      },
      complete: async () => {
        if (complete) throw new InvalidObjectInputError("O scanner foi finalizado duas vezes.");
        complete = true;
        if (byteLength === 0) throw new ScanRejectedError("O arquivo está vazio.");
        const contentType = input.contentType.toLowerCase().split(";", 1)[0]?.trim();
        if (input.format === "xlsx") {
          if (!xlsxContentTypes.has(contentType ?? "") || !isZipPrefix(prefix)) {
            throw new InvalidFormatError("O arquivo XLSX não corresponde ao formato declarado.");
          }
        } else if (!csvContentTypes.has(contentType ?? "") || isZipPrefix(prefix)) {
          throw new InvalidFormatError("O arquivo CSV não corresponde ao formato declarado.");
        }
        if (byteLength !== input.contentLength) {
          throw new InvalidObjectInputError("O tamanho informado não corresponde ao stream.");
        }
        return { status: "format_valid", format: input.format };
      },
    };
  }
}

export interface ObjectStorageClient {
  send(command: unknown): Promise<unknown>;
}

export class S3ObjectStorage implements ObjectStoragePort {
  private readonly maxBytes: number;
  private readonly maxTtlMs: number;
  private readonly scanner: FileScanPort;

  constructor(
    private readonly client: ObjectStorageClient,
    private readonly config: ObjectStorageConfig,
    scanner: FileScanPort = new FormatFileScanPort(config.maxBytes),
    private readonly clock: () => Date = () => new Date(),
  ) {
    validateConfig(config);
    this.maxBytes = config.maxBytes ?? DEFAULT_OBJECT_STORAGE_MAX_BYTES;
    this.maxTtlMs = config.maxTtlMs ?? DEFAULT_OBJECT_STORAGE_MAX_TTL_MS;
    this.scanner = scanner;
  }

  async put(input: ObjectStoragePutInput): Promise<ObjectStorageRecord> {
    validateKey(input.key);
    const now = input.now ?? this.clock();
    const expiresAt = validateExpiry(input.expiresAt, now, this.maxTtlMs);
    validateContentLength(input.contentLength, this.maxBytes);
    validateSha256(input.sha256);
    const scan = this.scanner.start({
      format: input.format,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
    let putStarted = false;
    let uploaded = false;
    try {
      const digest = createHash("sha256");
      let byteLength = 0;
      const body = Readable.from(
        this.trackedUploadBody(input.body, input.contentLength, digest, scan, (length) => {
          byteLength = length;
        }),
      );
      putStarted = true;
      const response = (await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: body,
          ContentLength: input.contentLength,
          ContentType: input.contentType,
          CacheControl: "no-store",
          Expires: expiresAt,
          ServerSideEncryption: "AES256",
          Metadata: {
            "casei-expires-at": expiresAt.toISOString(),
            "casei-sha256": input.sha256,
            "casei-format": input.format,
          },
        }),
      )) as { ETag?: string };
      uploaded = true;
      const sha256 = digest.digest("hex");
      if (byteLength !== input.contentLength) {
        throw new InvalidObjectInputError("O tamanho informado não corresponde ao stream.");
      }
      if (sha256 !== input.sha256) {
        throw new InvalidObjectInputError("O hash SHA-256 não corresponde ao stream.");
      }
      const scanResult = await scan.complete();
      if (scanResult.status === "rejected") {
        throw new ScanRejectedError(scanResult.reason);
      }
      return {
        key: input.key,
        contentLength: input.contentLength,
        contentType: input.contentType,
        etag: response.ETag ?? null,
        sha256,
        format: input.format,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      if (putStarted || uploaded) await this.delete({ key: input.key }).catch(() => undefined);
      if (error instanceof ObjectStorageError) throw error;
      throw mapProviderError(error);
    }
  }

  async head(input: { readonly key: string; readonly now?: Date }): Promise<ObjectStorageRecord> {
    validateKey(input.key);
    try {
      const response = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
      )) as S3ObjectResponse;
      return this.objectRecord(input.key, response, input.now ?? this.clock());
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw mapProviderError(error);
    }
  }

  async get(input: { readonly key: string; readonly now?: Date }): Promise<ObjectStorageRead> {
    validateKey(input.key);
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
      )) as S3ObjectResponse;
      const record = this.objectRecord(input.key, response, input.now ?? this.clock());
      if (!response.Body || !isAsyncIterable(response.Body)) {
        throw new ObjectStorageError("storage_unavailable", "O storage não retornou um stream.");
      }
      const source = response.Body as AsyncIterable<Uint8Array>;
      return {
        ...record,
        stream: this.trackedDownloadStream(source, record),
      };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      throw mapProviderError(error);
    }
  }

  async delete(input: { readonly key: string }): Promise<void> {
    validateKey(input.key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      throw mapProviderError(error);
    }
  }

  private async *trackedUploadBody(
    body: ObjectBody,
    contentLength: number,
    digest: ReturnType<typeof createHash>,
    scan: FileScanSession,
    updateLength: (length: number) => void,
  ): AsyncGenerator<Uint8Array> {
    let byteLength = 0;
    for await (const chunk of toAsyncIterable(body)) {
      const bytes = new Uint8Array(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > this.maxBytes) throw new InvalidObjectInputError();
      digest.update(bytes);
      await scan.accept(bytes);
      updateLength(byteLength);
      yield bytes;
    }
    if (byteLength !== contentLength) {
      throw new InvalidObjectInputError("O tamanho informado não corresponde ao stream.");
    }
  }

  private trackedDownloadStream(
    source: AsyncIterable<Uint8Array>,
    record: ObjectStorageRecord,
  ): ReadableStream<Uint8Array> {
    const iterator = source[Symbol.asyncIterator]();
    const digest = createHash("sha256");
    const expirationTime = new Date(record.expiresAt).getTime();
    let byteLength = 0;
    let finished = false;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (finished) return;
          if (this.clock().getTime() >= expirationTime) {
            finished = true;
            await iterator.return?.();
            controller.error(new ExpiredObjectError());
            return;
          }
          try {
            const next = await iterator.next();
            if (next.done) {
              finished = true;
              if (byteLength !== record.contentLength) {
                throw new InvalidObjectInputError("O tamanho do objeto mudou durante o download.");
              }
              if (record.sha256 && digest.digest("hex") !== record.sha256) {
                throw new InvalidObjectInputError("O hash SHA-256 do objeto não corresponde.");
              }
              controller.close();
              return;
            }
            if (this.clock().getTime() >= expirationTime) {
              finished = true;
              await iterator.return?.();
              controller.error(new ExpiredObjectError());
              return;
            }
            const bytes = new Uint8Array(next.value);
            byteLength += bytes.byteLength;
            if (byteLength > this.maxBytes) throw new InvalidObjectInputError();
            digest.update(bytes);
            controller.enqueue(bytes);
          } catch (error) {
            finished = true;
            await iterator.return?.();
            controller.error(error instanceof ObjectStorageError ? error : mapProviderError(error));
          }
        },
        cancel: async () => {
          finished = true;
          await iterator.return?.();
        },
      },
      { highWaterMark: 0 },
    );
  }

  private objectRecord(key: string, response: S3ObjectResponse, now: Date): ObjectStorageRecord {
    const expiresAt = response.Metadata?.["casei-expires-at"];
    if (!expiresAt)
      throw new ObjectStorageError("storage_unavailable", "O objeto não possui expiração.");
    const expiration = validateExpiry(expiresAt, now, this.maxTtlMs);
    const contentLength = response.ContentLength;
    if (
      typeof contentLength !== "number" ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > this.maxBytes
    ) {
      throw new InvalidObjectInputError("O objeto armazenado excede o limite permitido.");
    }
    const format = response.Metadata?.["casei-format"];
    if (format !== "csv" && format !== "xlsx") {
      throw new ObjectStorageError("storage_unavailable", "O objeto não possui formato seguro.");
    }
    const sha256 = response.Metadata?.["casei-sha256"];
    if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new ObjectStorageError("storage_unavailable", "O objeto não possui hash seguro.");
    }
    return {
      key,
      contentLength,
      contentType: response.ContentType ?? "application/octet-stream",
      etag: response.ETag ?? null,
      sha256,
      format,
      expiresAt: expiration.toISOString(),
    };
  }
}

export interface EnvironmentLike {
  readonly [key: string]: string | undefined;
}

export function objectStorageConfigFromEnvironment(
  env: EnvironmentLike = process.env,
): ObjectStorageConfig {
  const bucket = env.CASEI_OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) throw new Error("CASEI_OBJECT_STORAGE_BUCKET is required");
  const region = env.CASEI_OBJECT_STORAGE_REGION ?? "us-east-1";
  const endpoint = env.CASEI_OBJECT_STORAGE_ENDPOINT?.trim();
  if (endpoint) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("CASEI_OBJECT_STORAGE_ENDPOINT must be a valid URL");
    }
    if (
      !["http:", "https:"].includes(parsedEndpoint.protocol) ||
      parsedEndpoint.username ||
      parsedEndpoint.password
    ) {
      throw new Error("CASEI_OBJECT_STORAGE_ENDPOINT must be an HTTP(S) URL without credentials");
    }
    if (env.NODE_ENV === "production" && parsedEndpoint.protocol !== "https:") {
      throw new Error("CASEI_OBJECT_STORAGE_ENDPOINT must use HTTPS in production");
    }
  }
  const accessKeyId = env.CASEI_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.CASEI_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error(
      "CASEI_OBJECT_STORAGE_ACCESS_KEY_ID and SECRET_ACCESS_KEY must be provided together",
    );
  }
  const maxBytes = parseEnvironmentLimit(
    env.CASEI_OBJECT_STORAGE_MAX_BYTES,
    DEFAULT_OBJECT_STORAGE_MAX_BYTES,
  );
  const maxTtlMs = parseEnvironmentLimit(
    env.CASEI_OBJECT_STORAGE_MAX_TTL_MS,
    DEFAULT_OBJECT_STORAGE_MAX_TTL_MS,
  );
  if (maxBytes > DEFAULT_OBJECT_STORAGE_MAX_BYTES || maxTtlMs > DEFAULT_OBJECT_STORAGE_MAX_TTL_MS) {
    throw new Error("Object storage limits cannot exceed the MVP safety policy");
  }
  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
    forcePathStyle: parseBoolean(env.CASEI_OBJECT_STORAGE_FORCE_PATH_STYLE ?? "false"),
    maxBytes,
    maxTtlMs,
  };
}

export function createS3ObjectStorageFromEnvironment(
  env: EnvironmentLike = process.env,
  scanner?: FileScanPort,
): S3ObjectStorage {
  const config = objectStorageConfigFromEnvironment(env);
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }
      : {}),
  });
  return new S3ObjectStorage(client, config, scanner);
}

interface S3ObjectResponse {
  readonly Body?: unknown;
  readonly ContentLength?: number;
  readonly ContentType?: string;
  readonly ETag?: string;
  readonly Metadata?: Record<string, string>;
}

function validateConfig(config: ObjectStorageConfig): void {
  if (!config.bucket || !config.region)
    throw new Error("Object storage bucket and region are required");
  const maxBytes = config.maxBytes ?? DEFAULT_OBJECT_STORAGE_MAX_BYTES;
  const maxTtlMs = config.maxTtlMs ?? DEFAULT_OBJECT_STORAGE_MAX_TTL_MS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DEFAULT_OBJECT_STORAGE_MAX_BYTES
  ) {
    throw new Error("Object storage maxBytes must be between 1 and 10000000");
  }
  if (
    !Number.isSafeInteger(maxTtlMs) ||
    maxTtlMs < 1 ||
    maxTtlMs > DEFAULT_OBJECT_STORAGE_MAX_TTL_MS
  ) {
    throw new Error("Object storage maxTtlMs cannot exceed 24 hours");
  }
}

function validateKey(key: string): void {
  if (
    !key ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.split("/").some((part) => part === ".." || part === ".") ||
    hasControlCharacter(key)
  ) {
    throw new InvalidObjectInputError("A chave do objeto deve ser opaca e segura.");
  }
}

function validateContentLength(contentLength: number, maxBytes: number): void {
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxBytes) {
    throw new InvalidObjectInputError("O arquivo excede o limite permitido.");
  }
}

function validateSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new InvalidObjectInputError("O hash SHA-256 informado é inválido.");
  }
}

function validateExpiry(value: Date | string, now: Date, maxTtlMs: number): Date {
  const expiry = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(expiry.getTime()))
    throw new InvalidObjectInputError("A expiração do objeto é inválida.");
  if (expiry.getTime() <= now.getTime()) throw new ExpiredObjectError();
  if (expiry.getTime() - now.getTime() > maxTtlMs) {
    throw new InvalidObjectInputError("A retenção do arquivo não pode exceder 24 horas.");
  }
  return expiry;
}

function parseEnvironmentLimit(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("Object storage limits must be positive integers");
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("CASEI_OBJECT_STORAGE_FORCE_PATH_STYLE must be true or false");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isZipPrefix(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isIterable(value: unknown): value is Iterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

async function* toAsyncIterable(body: ObjectBody): AsyncGenerator<Uint8Array> {
  if (isAsyncIterable(body)) {
    yield* body;
    return;
  }
  if (isIterable(body)) {
    yield* body;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && ["NoSuchKey", "NotFound"].includes(String(error.name))) ||
      ("$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404))
  );
}

function mapProviderError(error: unknown): ObjectStorageError {
  if (isNotFound(error)) return new ObjectNotFoundError();
  return new ObjectStorageError(
    "storage_unavailable",
    "O armazenamento de arquivos está indisponível.",
  );
}
