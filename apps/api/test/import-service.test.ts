import type { ImportCreateRequest } from "@casei/contracts";
import { describe, expect, it } from "vitest";
import type {
  ImportBatchContext,
  ImportCommandContext,
  ImportCommandPort,
  ImportJobRecord,
  ImportLineResult,
  ImportReverseBatchContext,
  ImportReverseContext,
  ImportSource,
  ImportSourceRow,
  ImportStore,
} from "../src/import-service.js";
import { ImportApplication, ImportAuthorizationError } from "../src/import-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const actorId = "user-1";
const baseRequest: ImportCreateRequest = {
  domain: "products",
  storageKey: "dev/workspace/job/input.csv",
  sourceHash: "a".repeat(64),
  mappingVersion: "products-v1",
  previewHash: "b".repeat(64),
  mode: "valid_only",
  duplicatePolicy: "skip",
  acceptedDuplicateLines: [],
  totalRows: 3,
  validRows: 2,
  duplicateRows: 1,
  invalidRows: 0,
  expiresAt: "2026-08-26T00:00:00.000Z",
};

function source(rows: readonly ImportSourceRow[]): ImportSource {
  return {
    async readBatch({ cursor, limit }) {
      return rows.slice(cursor, cursor + limit);
    },
  };
}

class MemoryStore implements ImportStore {
  private readonly jobs = new Map<string, ImportJobRecord>();
  private readonly results = new Map<string, Map<number, ImportLineResult>>();
  authorized = true;
  nextId = 0;
  batchCalls = 0;

  async createJob(input: Parameters<ImportStore["createJob"]>[0]): Promise<ImportJobRecord> {
    const id = `job-${++this.nextId}`;
    const job: ImportJobRecord = {
      id,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requiredCapability: "import",
      idempotencyKey: input.idempotencyKey,
      domain: input.request.domain,
      storageKey: input.request.storageKey,
      sourceHash: input.request.sourceHash,
      mappingVersion: input.request.mappingVersion,
      previewHash: input.request.previewHash,
      mode: input.request.mode,
      duplicatePolicy: input.request.duplicatePolicy,
      acceptedDuplicateLines: input.request.acceptedDuplicateLines,
      totalRows: input.request.totalRows,
      validRows: input.request.validRows,
      duplicateRows: input.request.duplicateRows,
      invalidRows: input.request.invalidRows,
      appliedRows: 0,
      skippedRows: 0,
      rejectedRows: 0,
      cursor: 0,
      batchSize: input.batchSize,
      state: "queued",
      expiresAt: input.request.expiresAt,
      version: 0,
      correlationId: input.correlationId,
    };
    this.jobs.set(id, job);
    this.results.set(id, new Map());
    return job;
  }

  async getJob(id: string, scope: string): Promise<ImportJobRecord | null> {
    const job = this.jobs.get(id);
    return job?.workspaceId === scope ? job : null;
  }

  async runBatch<T>(
    jobId: string,
    scope: string,
    rows: readonly ImportSourceRow[],
    callback: (context: ImportBatchContext) => Promise<T>,
  ): Promise<T> {
    const job = await this.getJob(jobId, scope);
    if (!job) throw new Error("not found");
    this.batchCalls += 1;
    const beforeJob = job;
    const beforeResults = new Map(this.results.get(jobId));
    const context: ImportBatchContext = {
      job,
      rows,
      assertAuthorized: async () => {
        if (!this.authorized) throw new ImportAuthorizationError();
      },
      findLineResult: async (lineNumber) => this.results.get(jobId)?.get(lineNumber) ?? null,
      recordLine: async (result) => {
        this.results.get(jobId)?.set(result.lineNumber, result);
      },
      advance: async (cursor, counts) => {
        this.update(jobId, {
          cursor,
          appliedRows: job.appliedRows + (counts.appliedRows ?? 0),
          skippedRows: job.skippedRows + (counts.skippedRows ?? 0),
          rejectedRows: job.rejectedRows + (counts.rejectedRows ?? 0),
          state: "running",
          version: job.version + 1,
        });
      },
      complete: async () => this.update(jobId, { state: "succeeded", version: job.version + 1 }),
    };
    try {
      return await callback(context);
    } catch (error) {
      this.jobs.set(jobId, beforeJob);
      this.results.set(jobId, beforeResults);
      throw error;
    }
  }

  async runReverseBatch<T>(
    jobId: string,
    scope: string,
    callback: (context: ImportReverseBatchContext) => Promise<T>,
  ): Promise<T> {
    const job = await this.getJob(jobId, scope);
    if (!job) throw new Error("not found");
    const results = [...(this.results.get(jobId)?.values() ?? [])].filter(
      (result) => result.status === "applied",
    );
    const context: ImportReverseBatchContext = {
      job,
      rows: results.slice(0, job.batchSize),
      assertAuthorized: async () => {
        if (!this.authorized) throw new ImportAuthorizationError();
      },
      recordLine: async (result) => {
        this.results.get(jobId)?.set(result.lineNumber, result);
      },
      complete: async () => this.update(jobId, { state: "reversed", version: job.version + 1 }),
    };
    return callback(context);
  }

  async requestCancel(id: string, scope: string): Promise<ImportJobRecord> {
    const job = await this.getJob(id, scope);
    if (!job) throw new Error("not found");
    const state =
      job.state === "queued" || job.state === "running" ? "cancel_requested" : job.state;
    this.update(id, { state, version: job.version + 1 });
    return this.jobs.get(id) as ImportJobRecord;
  }

  async markCancelled(id: string, scope: string): Promise<ImportJobRecord> {
    const job = await this.getJob(id, scope);
    if (!job) throw new Error("not found");
    this.update(id, { state: "cancelled", version: job.version + 1 });
    return this.jobs.get(id) as ImportJobRecord;
  }

  async fail(id: string, scope: string): Promise<void> {
    const job = await this.getJob(id, scope);
    if (job) this.update(id, { state: "failed", version: job.version + 1 });
  }

  update(id: string, patch: Partial<ImportJobRecord>): void {
    const current = this.jobs.get(id) as ImportJobRecord;
    this.jobs.set(id, { ...current, ...patch });
  }

  resultsFor(id: string): readonly ImportLineResult[] {
    return [...(this.results.get(id)?.values() ?? [])];
  }
}

class MemoryCommands implements ImportCommandPort {
  applied: ImportCommandContext[] = [];
  reversed: ImportReverseContext[] = [];
  failOnLine: number | null = null;

  async apply(context: ImportCommandContext) {
    if (context.lineNumber === this.failOnLine) throw new Error("domain conflict");
    this.applied.push(context);
    return {
      targetType: "product",
      targetId: `target-${context.lineNumber}`,
      reversalToken: "opaque",
    };
  }

  async reverse(context: ImportReverseContext): Promise<void> {
    this.reversed.push(context);
  }

  async runAtomicBatch(
    _context: Parameters<ImportCommandPort["runAtomicBatch"]>[0],
    callback: Parameters<ImportCommandPort["runAtomicBatch"]>[1],
  ): Promise<void> {
    const applied = this.applied.length;
    try {
      await callback((command) => this.apply(command));
    } catch (error) {
      this.applied.splice(applied);
      throw error;
    }
  }
}

function rows(): readonly ImportSourceRow[] {
  return [
    { lineNumber: 2, status: "valid", values: { name: "Arroz" } },
    { lineNumber: 3, status: "duplicate", values: { name: "Feijão" }, fingerprint: "fp-1" },
    { lineNumber: 4, status: "valid", values: { name: "Café" } },
  ];
}

describe("DATA-004 aplicação de importação", () => {
  it("aplica linhas válidas em lotes, pula duplicatas e usa chave estável por linha", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 2 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-1",
      request: baseRequest,
    });
    const completed = await app.run(job.id, workspaceId);

    expect(completed.state).toBe("succeeded");
    expect(completed.cursor).toBe(3);
    expect(completed.appliedRows).toBe(2);
    expect(completed.skippedRows).toBe(1);
    expect(commands.applied.map((row) => row.idempotencyKey)).toEqual([
      `import:${job.id}:2`,
      `import:${job.id}:4`,
    ]);
    expect(store.batchCalls).toBe(3); // two data batches plus the empty completion batch
  });

  it("mantém a transação da linha independente quando uma válida falha", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    commands.failOnLine = 2;
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 3 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-2",
      request: baseRequest,
    });
    const completed = await app.run(job.id, workspaceId);

    expect(completed.state).toBe("succeeded");
    expect(completed.rejectedRows).toBe(1);
    expect(completed.appliedRows).toBe(1);
    expect(store.resultsFor(job.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineNumber: 2, status: "rejected", errorCode: "command_failed" }),
        expect.objectContaining({ lineNumber: 4, status: "applied" }),
      ]),
    );
  });

  it("exige batch atômico e deixa zero efeitos quando tudo-ou-nada falha", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    commands.failOnLine = 4;
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 3 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-atomic",
      request: {
        ...baseRequest,
        mode: "all_or_nothing",
        duplicatePolicy: "import",
      },
    });

    await expect(app.run(job.id, workspaceId)).rejects.toThrow("domain conflict");
    const failed = await store.getJob(job.id, workspaceId);
    expect(failed?.state).toBe("failed");
    expect(failed?.cursor).toBe(0);
    expect(store.resultsFor(job.id)).toEqual([]);
    expect(commands.applied).toEqual([]);
  });

  it("faz retry idempotente sem reaplicar linha registrada", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 3 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-3",
      request: baseRequest,
    });
    await app.run(job.id, workspaceId);
    store.update(job.id, { state: "failed" });
    await app.run(job.id, workspaceId);

    expect(commands.applied).toHaveLength(2);
  });

  it("cancela antes do lote seguinte quando membership/capacidade é revogada", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 2 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-4",
      request: baseRequest,
    });
    store.authorized = false;

    const cancelled = await app.run(job.id, workspaceId);
    expect(cancelled.state).toBe("cancelled");
    expect(commands.applied).toHaveLength(0);
  });

  it("reverte apenas linhas aplicadas, com chave de compensação idempotente", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 3 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-5",
      request: baseRequest,
    });
    await app.run(job.id, workspaceId);
    const reversed = await app.reverse(job.id, workspaceId);

    expect(reversed.state).toBe("reversed");
    expect(commands.reversed.map((row) => row.idempotencyKey)).toEqual([
      `import-reverse:${job.id}:2`,
      `import-reverse:${job.id}:4`,
    ]);
    expect(store.resultsFor(job.id).filter((row) => row.status === "reversed")).toHaveLength(2);
  });
});
