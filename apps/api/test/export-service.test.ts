import type { ExportCreateRequest } from "@casei/contracts";
import { JobAuthorizationError, type JobExecutionContext } from "@casei/database";
import type { ObjectStoragePort, ObjectStorageRead, ObjectStorageRecord } from "@casei/storage";
import { describe, expect, it } from "vitest";
import { createDefaultExportApplication } from "../src/app.js";
import type { DataExchangeExportContext } from "../src/data-exchange-routes.js";
import {
  ExportApplication,
  ExportAuthorizationError,
  ExportConflictError,
  ExportExpiredError,
  ExportFailure,
  type ExportJobRecord,
  type ExportJobStore,
  type ExportSource,
  PostgresExportSource,
} from "../src/export-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const actorId = "user-1";
const now = new Date("2026-09-03T12:00:00.000Z");

const request: ExportCreateRequest = { domain: "transactions", format: "csv" };

function context(role: DataExchangeExportContext["role"] = "member") {
  return {
    workspaceId,
    actorId,
    role,
    correlationId: "corr-1",
    origin: "api" as const,
  };
}

function job(overrides: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: "0190f3c8-2a10-7abc-8def-1234567890ac",
    workspaceId,
    actorId,
    idempotencyKey: "export-key-123456",
    requiredCapability: "export",
    request,
    fileName: "transactions.csv",
    storageKey: null,
    outputSha256: null,
    outputBytes: null,
    totalRows: null,
    processedRows: 0,
    progress: 0,
    state: "queued",
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    createdAt: now.toISOString(),
    completedAt: null,
    lastError: null,
    version: 0,
    correlationId: "corr-1",
    ...overrides,
  };
}

class MemoryExportStore implements ExportJobStore {
  record = job();
  downloads: string[] = [];

  async create(): Promise<ExportJobRecord> {
    return this.record;
  }

  async list(): Promise<readonly ExportJobRecord[]> {
    return [this.record];
  }

  async get(): Promise<ExportJobRecord | null> {
    return this.record;
  }

  async markRunning(): Promise<ExportJobRecord> {
    this.record = { ...this.record, state: "running" };
    return this.record;
  }

  async complete(
    _id: string,
    _workspaceId: string,
    input: Parameters<ExportJobStore["complete"]>[2],
  ): Promise<ExportJobRecord> {
    this.record = {
      ...this.record,
      state: "completed",
      storageKey: input.storageKey,
      outputSha256: input.outputSha256,
      outputBytes: input.outputBytes,
      totalRows: input.totalRows,
      processedRows: input.totalRows,
      progress: 100,
    };
    return this.record;
  }

  async fail(_id: string, _workspaceId: string, error: string): Promise<void> {
    this.record = { ...this.record, state: "failed", lastError: error };
  }

  async expire(): Promise<ExportJobRecord> {
    this.record = { ...this.record, state: "expired" };
    return this.record;
  }

  async recordDownload(input: { id: string }): Promise<void> {
    this.downloads.push(input.id);
  }
}

class MemoryStorage implements ObjectStoragePort {
  bytes = new Map<string, Uint8Array>();
  records = new Map<string, ObjectStorageRecord>();

  async put(input: Parameters<ObjectStoragePort["put"]>[0]): Promise<ObjectStorageRecord> {
    const bytes = new Uint8Array(input.contentLength);
    let offset = 0;
    for await (const chunk of toAsync(input.body)) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.bytes.set(input.key, bytes);
    const record = {
      key: input.key,
      contentLength: bytes.byteLength,
      contentType: input.contentType,
      etag: null,
      sha256: input.sha256,
      format: input.format,
      expiresAt: new Date(input.expiresAt).toISOString(),
    };
    this.records.set(input.key, record);
    return record;
  }

  async head(input: Parameters<ObjectStoragePort["head"]>[0]): Promise<ObjectStorageRecord> {
    const bytes = this.bytes.get(input.key);
    const record = this.records.get(input.key);
    if (!bytes || !record) throw new Error("not found");
    return record;
  }

  async get(input: Parameters<ObjectStoragePort["get"]>[0]): Promise<ObjectStorageRead> {
    const bytes = this.bytes.get(input.key);
    if (!bytes) throw new Error("not found");
    const record = await this.head(input);
    return {
      ...record,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  }

  async delete(input: Parameters<ObjectStoragePort["delete"]>[0]): Promise<void> {
    this.bytes.delete(input.key);
    this.records.delete(input.key);
  }
}

async function* toAsync(
  body: Parameters<ObjectStoragePort["put"]>[0]["body"],
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in Object(body)) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  if (Symbol.iterator in Object(body)) {
    yield* body as Iterable<Uint8Array>;
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

function source(): ExportSource {
  return {
    async read() {
      return {
        timeZone: "America/Fortaleza",
        currency: "BRL",
        files: [
          {
            domain: "transactions",
            schemaVersion: "1",
            columns: [{ key: "description" }],
            rows: [{ casei_id: "tx-1", description: "Mercado" }],
            totalRows: 1,
          },
        ],
      };
    },
  };
}

describe("ExportApplication", () => {
  it("requires the owner for complete exports but allows a viewer to export visible data", async () => {
    const store = new MemoryExportStore();
    const application = new ExportApplication(store, source(), new MemoryStorage(), {
      environment: "test",
      now: () => now,
    });

    await expect(
      application.create({
        ...context("viewer"),
        request: { domain: "complete", format: "zip" },
        idempotencyKey: "export-key-123456",
      }),
    ).rejects.toBeInstanceOf(ExportAuthorizationError);
    await expect(
      application.create({ ...context("viewer"), request, idempotencyKey: "export-key-123456" }),
    ).resolves.toMatchObject({ status: "queued" });

    store.record = job({
      request: { domain: "complete", format: "zip" },
      state: "completed",
      storageKey: "test/export.zip",
    });
    await expect(
      application.get({ ...context("viewer"), exportId: store.record.id }),
    ).rejects.toBeInstanceOf(ExportAuthorizationError);
    await expect(
      application.download({ ...context("member"), exportId: store.record.id }),
    ).rejects.toBeInstanceOf(ExportAuthorizationError);
  });

  it("generates a versioned CSV, stores it, and records an authorized download", async () => {
    const store = new MemoryExportStore();
    const storage = new MemoryStorage();
    const application = new ExportApplication(store, source(), storage, {
      environment: "test",
      now: () => now,
    });

    await application.run(store.record.id, workspaceId);
    expect(store.record).toMatchObject({ state: "completed", totalRows: 1, progress: 100 });
    const download = await application.download({
      ...context("viewer"),
      exportId: store.record.id,
    });
    expect(await new Response(download.body as ReadableStream<Uint8Array>).text()).toContain(
      "casei_id",
    );
    expect(store.downloads).toEqual([store.record.id]);
  });

  it("does not consume a one-shot source twice when generating a filtered ZIP", async () => {
    const store = new MemoryExportStore();
    store.record = job({
      request: { domain: "transactions", format: "zip" },
      fileName: "transactions.zip",
    });
    const storage = new MemoryStorage();
    const application = new ExportApplication(
      store,
      {
        async read() {
          return {
            timeZone: "America/Fortaleza",
            currency: "BRL",
            files: [
              {
                domain: "transactions",
                schemaVersion: "1",
                columns: [{ key: "description" }],
                rows: (function* () {
                  yield { casei_id: "tx-1", description: "Mercado" };
                })(),
                totalRows: 1,
              },
            ],
          };
        },
      },
      storage,
      { environment: "test", now: () => now },
    );

    await application.run(store.record.id, workspaceId);
    const output = storage.bytes.get(store.record.storageKey ?? "");
    expect(output?.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(output?.byteLength).toBeGreaterThan(100);
  });

  it("does not stream an object whose integrity metadata changed", async () => {
    const store = new MemoryExportStore();
    const storage = new MemoryStorage();
    const application = new ExportApplication(store, source(), storage, {
      environment: "test",
      now: () => now,
    });

    await application.run(store.record.id, workspaceId);
    const key = store.record.storageKey;
    if (!key) throw new Error("export storage key missing");
    const record = storage.records.get(key);
    if (!record) throw new Error("stored export missing");
    storage.records.set(key, { ...record, sha256: "a".repeat(64) });

    await expect(
      application.download({ ...context("member"), exportId: store.record.id }),
    ).rejects.toBeInstanceOf(ExportFailure);
    expect(store.downloads).toEqual([]);
  });

  it("revalidates authorization before completing and cleans up on revocation", async () => {
    const store = new MemoryExportStore();
    const storage = new MemoryStorage();
    const execution: JobExecutionContext = {
      runBatch: async (callback) =>
        callback({
          client: {} as never,
          beforeTransition: async () => {
            throw new JobAuthorizationError();
          },
          renewLease: async () => true,
        }),
      renewLease: async () => true,
    };
    const application = new ExportApplication(store, source(), storage, {
      environment: "test",
      now: () => now,
    });

    await expect(application.run(store.record.id, workspaceId, execution)).rejects.toBeInstanceOf(
      JobAuthorizationError,
    );
    expect(storage.bytes).toHaveLength(0);
    expect(store.record.state).toBe("running");
  });

  it("rejects expired jobs before exposing an object", async () => {
    const store = new MemoryExportStore();
    store.record = job({
      expiresAt: new Date(now.getTime() - 1).toISOString(),
      state: "completed",
      storageKey: "test/key",
    });
    const application = new ExportApplication(store, source(), new MemoryStorage(), {
      environment: "test",
      now: () => now,
    });
    await expect(
      application.download({ ...context(), exportId: store.record.id }),
    ).rejects.toBeInstanceOf(ExportExpiredError);
  });

  it("rejects an invalid date range before creating a job", async () => {
    const store = new MemoryExportStore();
    const application = new ExportApplication(store, source(), new MemoryStorage(), {
      environment: "test",
      now: () => now,
    });
    await expect(
      application.create({
        ...context(),
        request: { ...request, from: "2026-09-04", to: "2026-09-03" },
        idempotencyKey: "export-key-123456",
      }),
    ).rejects.toBeInstanceOf(ExportConflictError);
  });

  it("builds the production export application only when object storage is configured", () => {
    expect(createDefaultExportApplication({ pool: {} as never, env: {} })).toBeUndefined();
    expect(
      createDefaultExportApplication({
        pool: {} as never,
        env: {
          NODE_ENV: "production",
          CASEI_OBJECT_STORAGE_BUCKET: "casei-private",
          CASEI_OBJECT_STORAGE_REGION: "sa-east-1",
        },
      }),
    ).toBeDefined();
  });

  it("reads only scoped transaction/product projections under the application role", async () => {
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      async query<T>(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, values });
        if (sql.includes("FROM workspace_preference")) {
          return { rows: [{ currency_code: "BRL", timezone: "America/Fortaleza" }] } as {
            rows: T[];
          };
        }
        if (sql.includes("FROM finance_transaction") && sql.includes("count(*)")) {
          return { rows: [{ count: "1" }] } as { rows: T[] };
        }
        if (sql.includes("FROM finance_transaction")) {
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ad",
                kind: "expense",
                amount_minor: "1234",
                occurred_on: "2026-09-03",
                state: "posted",
                description: "Mercado",
                category_id: null,
                due_on: null,
                instrument: "wallet",
              },
            ],
          } as { rows: T[] };
        }
        if (sql.includes("FROM stock_product") && sql.includes("count(*)")) {
          return { rows: [{ count: "1" }] } as { rows: T[] };
        }
        if (sql.includes("FROM stock_product")) {
          return {
            rows: [
              {
                id: "0190f3c8-2a10-7abc-8def-1234567890ae",
                name: "Arroz",
                quantity_milli: "2000",
                unit: "g",
                minimum_milli: "1000",
                category: "secos",
                location: "despensa",
                archived: false,
                marked_missing: false,
              },
            ],
          } as { rows: T[] };
        }
        return { rows: [] } as { rows: T[] };
      },
      release() {},
    };
    const pool = { connect: async () => client } as never;
    const source = new PostgresExportSource(pool);
    const result = await source.read({
      workspaceId,
      actorId,
      request: {
        domain: "complete",
        format: "zip",
        from: "2026-09-01",
        to: "2026-09-03",
        kind: "expense",
      },
    });
    expect(result.files.map((file) => file.domain)).toEqual(["transactions", "products"]);
    const transactionFile = result.files.find((file) => file.domain === "transactions");
    const productFile = result.files.find((file) => file.domain === "products");
    expect(transactionFile).toBeDefined();
    expect(productFile).toBeDefined();
    expect([...(transactionFile?.rows ?? [])][0]).toMatchObject({
      amount: "12,34",
      description: "Mercado",
    });
    expect([...(productFile?.rows ?? [])][0]).toMatchObject({ name: "Arroz", quantity: "2" });
    expect(statements.some(({ sql }) => sql.includes('SET LOCAL ROLE "casei_app"'))).toBe(true);
    const transactionQuery = statements.find(
      ({ sql }) => sql.includes("FROM finance_transaction") && !sql.includes("count(*)"),
    );
    expect(transactionQuery?.values).toEqual([workspaceId, "2026-09-01", "2026-09-03", "expense"]);
  });
});
