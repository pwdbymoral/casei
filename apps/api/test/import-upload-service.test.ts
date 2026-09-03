import {
  ObjectStorageError,
  type ObjectStoragePort,
  type ObjectStorageRead,
  type ObjectStorageRecord,
} from "@casei/storage";
import { describe, expect, it } from "vitest";
import type { ImportUploadError } from "../src/data-exchange-routes.js";
import {
  type ImportPreviewStore,
  ImportUploadService,
  type StoredImportPreview,
} from "../src/import-upload-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const now = new Date("2026-08-25T12:00:00.000Z");

class MemoryStorage implements ObjectStoragePort {
  readonly puts: Array<{ key: string; bytes: Uint8Array; sha256: string }> = [];
  headError?: ObjectStorageError;

  async put(input: Parameters<ObjectStoragePort["put"]>[0]): Promise<ObjectStorageRecord> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.body) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.puts.push({ key: input.key, bytes, sha256: input.sha256 });
    return {
      key: input.key,
      contentLength: input.contentLength,
      contentType: input.contentType,
      etag: null,
      sha256: input.sha256,
      format: input.format,
      expiresAt: new Date(input.expiresAt).toISOString(),
    };
  }

  async head(input: { key: string }): Promise<ObjectStorageRecord> {
    if (this.headError) throw this.headError;
    const stored = this.puts.find((put) => put.key === input.key);
    if (!stored) throw new Error("missing");
    return {
      key: stored.key,
      contentLength: stored.bytes.byteLength,
      contentType: "text/csv",
      etag: null,
      sha256: stored.sha256,
      format: "csv",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
  }

  async get(): Promise<ObjectStorageRead> {
    throw new Error("not used");
  }

  async delete(): Promise<void> {
    return;
  }
}

class MemoryPreviews implements ImportPreviewStore {
  readonly values = new Map<string, StoredImportPreview>();

  async save(preview: StoredImportPreview): Promise<void> {
    this.values.set(preview.response.id, preview);
  }

  async get(workspace: string, id: string): Promise<StoredImportPreview | null> {
    const value = this.values.get(id);
    return value?.response.workspaceId === workspace ? value : null;
  }
}

function service() {
  return {
    storage: new MemoryStorage(),
    previews: new MemoryPreviews(),
  };
}

describe("ImportUploadService", () => {
  it("parses, preflights and stores an opaque CSV object before returning a manifest", async () => {
    const dependencies = service();
    const application = new ImportUploadService({
      ...dependencies,
      environment: "test",
      now: () => now,
    });
    const bytes = new TextEncoder().encode("nome;quantidade\nArroz;2\n");

    const preview = await application.preview({
      workspaceId,
      actorId: "user-1",
      correlationId: "corr-1",
      domain: "products",
      locale: "pt-BR",
      mapping: {},
      fileName: "produtos.csv",
      contentType: "text/csv",
      bytes,
    });

    expect(preview.serverBacked).toBe(true);
    expect(preview.canConfirm).toBe(true);
    expect(preview.counts.valid).toBe(1);
    expect(preview.previewManifest).toHaveLength(1);
    expect(preview.storageKey).toMatch(/^test\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.csv$/u);
    expect(dependencies.storage.puts[0]?.bytes).toEqual(bytes);

    const request = await application.confirm({
      workspaceId,
      actorId: "user-1",
      correlationId: "corr-1",
      fileName: "produtos.csv",
      contentType: "text/csv",
      bytes,
      previewId: preview.id,
      mapping: preview.mapping,
      mode: "valid_only",
      duplicatePolicy: "skip",
    });
    expect(request).toMatchObject({
      storageKey: preview.storageKey,
      sourceHash: preview.sourceHash,
      previewHash: preview.previewHash,
      totalRows: 1,
    });
  });

  it("rejects a changed source instead of confirming a stale preview", async () => {
    const dependencies = service();
    const application = new ImportUploadService({
      ...dependencies,
      environment: "test",
      now: () => now,
    });
    const bytes = new TextEncoder().encode("nome\nArroz\n");
    const preview = await application.preview({
      workspaceId,
      actorId: "user-1",
      correlationId: "corr-1",
      domain: "products",
      locale: "pt-BR",
      mapping: {},
      fileName: "produtos.csv",
      contentType: "text/csv",
      bytes,
    });

    await expect(
      application.confirm({
        workspaceId,
        actorId: "user-1",
        correlationId: "corr-1",
        fileName: "produtos.csv",
        contentType: "text/csv",
        bytes: new TextEncoder().encode("nome\nFeijao\n"),
        previewId: preview.id,
        mapping: preview.mapping,
        mode: "valid_only",
        duplicatePolicy: "skip",
      }),
    ).rejects.toMatchObject({
      code: "source_mismatch",
    } satisfies Partial<ImportUploadError>);
  });

  it("rejects an unsupported file extension before storage", async () => {
    const dependencies = service();
    const application = new ImportUploadService({
      ...dependencies,
      environment: "test",
      now: () => now,
    });
    await expect(
      application.preview({
        workspaceId,
        actorId: "user-1",
        correlationId: "corr-1",
        domain: "products",
        locale: "pt-BR",
        mapping: {},
        fileName: "produtos.xls",
        contentType: "application/octet-stream",
        bytes: new TextEncoder().encode("nome\nArroz\n"),
      }),
    ).rejects.toMatchObject({ code: "invalid_file" });
    expect(dependencies.storage.puts).toHaveLength(0);
  });

  it.each([
    ["object_not_found", "not_found"],
    ["object_expired", "expired"],
    ["storage_unavailable", "storage_unavailable"],
  ] as const)("preserves storage state %s while confirming", async (storageCode, errorCode) => {
    const dependencies = service();
    dependencies.storage.headError = new ObjectStorageError(storageCode, "storage failure");
    const application = new ImportUploadService({
      ...dependencies,
      environment: "test",
      now: () => now,
    });
    const bytes = new TextEncoder().encode("nome\nArroz\n");
    const preview = await application.preview({
      workspaceId,
      actorId: "user-1",
      correlationId: "corr-storage-state",
      domain: "products",
      locale: "pt-BR",
      mapping: {},
      fileName: "produtos.csv",
      contentType: "text/csv",
      bytes,
    });

    await expect(
      application.confirm({
        workspaceId,
        actorId: "user-1",
        correlationId: "corr-storage-state",
        fileName: "produtos.csv",
        contentType: "text/csv",
        bytes,
        previewId: preview.id,
        mapping: preview.mapping,
        mode: "valid_only",
        duplicatePolicy: "skip",
      }),
    ).rejects.toMatchObject({ code: errorCode } satisfies Partial<ImportUploadError>);
  });
});
