import { describe, expect, it } from "vitest";

import {
  ExpiredObjectError,
  FormatFileScanPort,
  InvalidFormatError,
  InvalidObjectInputError,
  type ObjectStorageClient,
  ObjectStorageError,
  objectStorageConfigFromEnvironment,
  S3ObjectStorage,
  ScanRejectedError,
} from "../src/index.js";

const config = {
  bucket: "casei-test",
  region: "us-east-1",
  maxBytes: 10,
  maxTtlMs: 24 * 60 * 60 * 1000,
};

function fakeClient(handler: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  return { send: handler } as unknown as ObjectStorageClient;
}

describe("ObjectStoragePort S3-compatible", () => {
  it("uploads a bounded stream, verifies SHA-256 and sends only opaque metadata", async () => {
    let received = "";
    let putInput: Record<string, unknown> | undefined;
    const client = fakeClient(async (command) => {
      putInput = command.input;
      const body = command.input.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of body) received += new TextDecoder().decode(chunk);
      return { ETag: '"etag-1"' };
    });
    const storage = new S3ObjectStorage(client, config);
    const expiresAt = new Date(Date.now() + 60_000);

    const result = await storage.put({
      key: "prod/0190f3c8/job-1/input.csv",
      body: [new TextEncoder().encode("a,b\n1,2")],
      contentLength: 7,
      contentType: "text/csv",
      format: "csv",
      expiresAt,
      sha256: "aeedab1ee7a1043753c9ab768594bc8420d7b85491d0be9421edc3813c237f4c",
    });

    expect(received).toBe("a,b\n1,2");
    expect(result.key).toBe("prod/0190f3c8/job-1/input.csv");
    expect(putInput).toMatchObject({
      Bucket: "casei-test",
      Key: "prod/0190f3c8/job-1/input.csv",
      ContentLength: 7,
      ContentType: "text/csv",
      CacheControl: "no-store",
      ServerSideEncryption: "AES256",
      Metadata: {
        "casei-format": "csv",
        "casei-sha256": "aeedab1ee7a1043753c9ab768594bc8420d7b85491d0be9421edc3813c237f4c",
      },
    });
    expect(putInput).not.toHaveProperty("OriginalName");
  });

  it("rejects a length mismatch before confirming the object and cleans partial uploads", async () => {
    const calls: { input: Record<string, unknown> }[] = [];
    const storage = new S3ObjectStorage(
      fakeClient(async (command) => {
        calls.push(command as { input: Record<string, unknown> });
        if (command.input.Body) {
          for await (const _chunk of command.input.Body as AsyncIterable<Uint8Array>) {
            // Consume the stream as S3 would.
          }
        }
        return {};
      }),
      config,
    );

    await expect(
      storage.put({
        key: "prod/workspace/job/input.csv",
        body: [new TextEncoder().encode("too-long")],
        contentLength: 2,
        contentType: "text/csv",
        format: "csv",
        expiresAt: new Date(Date.now() + 60_000),
        sha256: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidObjectInputError);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input).toMatchObject({
      Bucket: "casei-test",
      Key: "prod/workspace/job/input.csv",
    });
    expect(calls[1]?.input).not.toHaveProperty("Body");
  });

  it("rejects an expired object before returning any body", async () => {
    const storage = new S3ObjectStorage(
      fakeClient(async () => ({
        Body: [new TextEncoder().encode("a,b")],
        ContentLength: 3,
        ContentType: "text/csv",
        Metadata: { "casei-expires-at": new Date(Date.now() - 1_000).toISOString() },
      })),
      config,
    );

    await expect(storage.get({ key: "prod/workspace/job/input.csv" })).rejects.toBeInstanceOf(
      ExpiredObjectError,
    );
  });

  it("returns a lazy ReadableStream and verifies length/hash at EOF", async () => {
    let consumed = false;
    const storage = new S3ObjectStorage(
      fakeClient(async () => ({
        Body: (async function* () {
          consumed = true;
          yield new TextEncoder().encode("a,b");
          yield new TextEncoder().encode("\n1,2");
        })(),
        ContentLength: 7,
        ContentType: "text/csv",
        ETag: '"etag-1"',
        Metadata: {
          "casei-expires-at": new Date(Date.now() + 60_000).toISOString(),
          "casei-sha256": "aeedab1ee7a1043753c9ab768594bc8420d7b85491d0be9421edc3813c237f4c",
          "casei-format": "csv",
        },
      })),
      config,
    );

    const result = await storage.get({ key: "prod/workspace/job/input.csv" });
    await expect(new Response(result.stream).text()).resolves.toBe("a,b\n1,2");
    expect(consumed).toBe(true);
  });

  it("stops a download when the logical TTL expires between chunks", async () => {
    let now = new Date("2026-08-25T17:00:00.000Z");
    let releaseSecondChunk!: () => void;
    const secondChunkReady = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const storage = new S3ObjectStorage(
      fakeClient(async () => ({
        Body: (async function* () {
          yield new TextEncoder().encode("a,b");
          await secondChunkReady;
          yield new TextEncoder().encode("\n1,2");
        })(),
        ContentLength: 7,
        ContentType: "text/csv",
        Metadata: {
          "casei-expires-at": "2026-08-25T18:00:00.000Z",
          "casei-sha256": "aeedab1ee7a1043753c9ab768594bc8420d7b85491d0be9421edc3813c237f4c",
          "casei-format": "csv",
        },
      })),
      config,
      undefined,
      () => now,
    );

    const result = await storage.get({ key: "prod/workspace/job/input.csv", now });
    const reader = result.stream.getReader();
    const firstRead = await reader.read();
    expect(firstRead).toMatchObject({ done: false });
    now = new Date("2026-08-25T18:00:01.000Z");
    releaseSecondChunk();
    try {
      await reader.read();
      throw new Error("expected expiration");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpiredObjectError);
    }
  });

  it("keeps the format scanner explicit and rejects mismatched MIME/magic", async () => {
    const scanner = new FormatFileScanPort();
    const session = scanner.start({ format: "xlsx", contentType: "text/csv", contentLength: 3 });
    await session.accept(new TextEncoder().encode("a,b"));
    await expect(session.complete()).rejects.toBeInstanceOf(InvalidFormatError);
  });

  it("lets the deployment inject a malware scanner without making the adapter claim a clean verdict", async () => {
    let deleted = false;
    const scanner = {
      start: () => ({
        accept: async () => undefined,
        complete: async () => {
          throw new ScanRejectedError();
        },
      }),
    };
    const storage = new S3ObjectStorage(
      fakeClient(async (command) => {
        if (!command.input.Body) deleted = true;
        if (command.input.Body) {
          for await (const _chunk of command.input.Body as AsyncIterable<Uint8Array>) {
            // Consume the upload before the scanner verdict is returned.
          }
        }
        return {};
      }),
      config,
      scanner,
    );

    await expect(
      storage.put({
        key: "prod/workspace/job/input.csv",
        body: [new TextEncoder().encode("a,b")],
        contentLength: 3,
        contentType: "text/csv",
        format: "csv",
        expiresAt: new Date(Date.now() + 60_000),
        sha256: "1eb7c54d52831bbfe8942af0b1c56b7409523a59ed6ca99c1174fef7eb32c1b5",
      }),
    ).rejects.toBeInstanceOf(ScanRejectedError);
    expect(deleted).toBe(true);
  });

  it("requires explicit production storage configuration and rejects partial credentials", () => {
    expect(() => objectStorageConfigFromEnvironment({})).toThrow(/BUCKET/);
    expect(() =>
      objectStorageConfigFromEnvironment({
        CASEI_OBJECT_STORAGE_BUCKET: "casei",
        CASEI_OBJECT_STORAGE_ACCESS_KEY_ID: "access",
      }),
    ).toThrow(/provided together/);
    expect(
      objectStorageConfigFromEnvironment({
        CASEI_OBJECT_STORAGE_BUCKET: "casei",
        CASEI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      }),
    ).toMatchObject({ bucket: "casei", region: "us-east-1", forcePathStyle: true });
  });

  it("exposes storage failures without leaking provider response details", () => {
    const error = new ObjectStorageError("storage_unavailable", "Falha temporária.");
    expect(error).toMatchObject({ code: "storage_unavailable", message: "Falha temporária." });
  });
});
