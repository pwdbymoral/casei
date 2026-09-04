import type { ImportCreateRequest } from "@casei/contracts";
import type { JobExecutionContext } from "@casei/database";
import { describe, expect, it, vi } from "vitest";
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
import {
  createImportPreviewHash,
  ImportApplication,
  ImportAuthorizationError,
  PostgresImportStore,
} from "../src/import-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";
const actorId = "user-1";
const previewManifest = [
  { lineNumber: 2, status: "valid" as const, rowDigest: "2".repeat(64) },
  {
    lineNumber: 3,
    status: "duplicate" as const,
    rowDigest: "3".repeat(64),
    fingerprint: "f".repeat(64),
  },
  { lineNumber: 4, status: "valid" as const, rowDigest: "4".repeat(64) },
];
const importFixtureExpiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const baseRequest: ImportCreateRequest = {
  domain: "products",
  storageKey: "dev/workspace/job/input.csv",
  sourceHash: "a".repeat(64),
  mappingVersion: "products-v1",
  previewHash: createImportPreviewHash(previewManifest),
  previewManifest,
  mode: "valid_only",
  duplicatePolicy: "skip",
  acceptedDuplicateLines: [],
  totalRows: 3,
  validRows: 2,
  duplicateRows: 1,
  invalidRows: 0,
  expiresAt: importFixtureExpiry,
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
  lastExecution?: JobExecutionContext;

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
      previewManifest: input.request.previewManifest,
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
    execution?: JobExecutionContext,
  ): Promise<T> {
    const job = await this.getJob(jobId, scope);
    if (!job) throw new Error("not found");
    this.batchCalls += 1;
    this.lastExecution = execution;
    const beforeJob = job;
    const beforeResults = new Map(this.results.get(jobId));
    const context: ImportBatchContext = {
      job,
      rows,
      renewLease: async () => true,
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
    _requester?: Parameters<ImportStore["runReverseBatch"]>[3],
  ): Promise<T> {
    const job = await this.getJob(jobId, scope);
    if (!job) throw new Error("not found");
    const results = [...(this.results.get(jobId)?.values() ?? [])].filter(
      (result) => result.status === "applied",
    );
    const context: ImportReverseBatchContext = {
      job,
      rows: results.slice(0, job.batchSize),
      requester: _requester,
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

  async listLineResults(id: string, scope: string, afterLine: number | undefined, limit: number) {
    const job = await this.getJob(id, scope);
    if (!job) throw new Error("not found");
    const all = [...(this.results.get(id)?.values() ?? [])].sort(
      (left, right) => left.lineNumber - right.lineNumber,
    );
    const filtered = all.filter((line) => afterLine === undefined || line.lineNumber > afterLine);
    const items = filtered.slice(0, limit);
    return {
      items,
      nextAfterLine: filtered.length > limit ? (items.at(-1)?.lineNumber ?? null) : null,
    };
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
    { lineNumber: 2, status: "valid", rowDigest: "2".repeat(64), values: { name: "Arroz" } },
    {
      lineNumber: 3,
      status: "duplicate",
      rowDigest: "3".repeat(64),
      values: { name: "Feijão" },
      fingerprint: "f".repeat(64),
    },
    { lineNumber: 4, status: "valid", rowDigest: "4".repeat(64), values: { name: "Café" } },
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

  it("não cria job para arquivo expirado ou com retenção acima de 24 horas", async () => {
    const store = new MemoryStore();
    const app = new ImportApplication(store, source(rows()), new MemoryCommands());
    const expired = new Date(Date.now() - 1_000).toISOString();
    const tooLong = new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString();
    await expect(
      app.create({
        workspaceId,
        actorId,
        correlationId: "corr-expired",
        request: { ...baseRequest, expiresAt: expired },
      }),
    ).rejects.toThrow("até 24 horas");
    await expect(
      app.create({
        workspaceId,
        actorId,
        correlationId: "corr-too-long",
        request: { ...baseRequest, expiresAt: tooLong },
      }),
    ).rejects.toThrow("até 24 horas");
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

  it("persiste todo o job no mesmo lote quando tudo-ou-nada é selecionado", async () => {
    const store = new MemoryStore();
    const app = new ImportApplication(store, source(rows()), new MemoryCommands(), {
      batchSize: 1,
    });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-atomic-job",
      request: {
        ...baseRequest,
        mode: "all_or_nothing",
        duplicatePolicy: "import",
      },
    });

    expect(job.batchSize).toBe(baseRequest.totalRows);
  });

  it("recusa uma fonte que diverge do digest confirmado na prévia", async () => {
    const store = new MemoryStore();
    const firstRow = rows()[0];
    if (!firstRow) throw new Error("fixture row missing");
    const app = new ImportApplication(
      store,
      source([{ ...firstRow, rowDigest: "d".repeat(64) }]),
      new MemoryCommands(),
    );
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-manifest",
      request: baseRequest,
    });

    await expect(app.run(job.id, workspaceId)).rejects.toThrow("manifesto confirmado");
    expect((await store.getJob(job.id, workspaceId))?.state).toBe("failed");
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

  it("permite rejeitar todas as duplicatas na revisão individual", async () => {
    const app = new ImportApplication(new MemoryStore(), source(rows()), new MemoryCommands());

    await expect(
      app.create({
        workspaceId,
        actorId,
        correlationId: "corr-review",
        request: {
          ...baseRequest,
          duplicatePolicy: "review",
          acceptedDuplicateLines: [],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("permite selecionar apenas parte das duplicatas na revisão individual", async () => {
    const manifest = [
      {
        lineNumber: 2,
        status: "duplicate" as const,
        rowDigest: "2".repeat(64),
        fingerprint: "f".repeat(64),
      },
      {
        lineNumber: 3,
        status: "duplicate" as const,
        rowDigest: "3".repeat(64),
        fingerprint: "f".repeat(64),
      },
    ];
    const app = new ImportApplication(new MemoryStore(), source([]), new MemoryCommands());

    await expect(
      app.create({
        workspaceId,
        actorId,
        correlationId: "corr-review-partial",
        request: {
          ...baseRequest,
          previewHash: createImportPreviewHash(manifest),
          previewManifest: manifest,
          duplicatePolicy: "review",
          acceptedDuplicateLines: [2],
          totalRows: 2,
          validRows: 0,
          duplicateRows: 2,
          invalidRows: 0,
        },
      }),
    ).resolves.toBeDefined();
  });

  it("aplica as duplicatas aceitas e ignora as demais", async () => {
    const manifest = [
      {
        lineNumber: 2,
        status: "duplicate" as const,
        rowDigest: "2".repeat(64),
        fingerprint: "f".repeat(64),
      },
      {
        lineNumber: 3,
        status: "duplicate" as const,
        rowDigest: "3".repeat(64),
        fingerprint: "f".repeat(64),
      },
    ];
    const rowsToProcess: ImportSourceRow[] = manifest.map((line) => ({
      lineNumber: line.lineNumber,
      status: "duplicate",
      rowDigest: line.rowDigest,
      values: { name: `Produto ${line.lineNumber}` },
      fingerprint: "f".repeat(64),
    }));
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    const app = new ImportApplication(store, source(rowsToProcess), commands, { batchSize: 2 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-review-run",
      request: {
        ...baseRequest,
        previewHash: createImportPreviewHash(manifest),
        previewManifest: manifest,
        duplicatePolicy: "review",
        acceptedDuplicateLines: [2],
        totalRows: 2,
        validRows: 0,
        duplicateRows: 2,
        invalidRows: 0,
      },
    });

    const result = await app.run(job.id, workspaceId);

    expect(result.state).toBe("succeeded");
    expect(result.appliedRows).toBe(1);
    expect(result.skippedRows).toBe(1);
    expect(commands.applied.map((command) => command.lineNumber)).toEqual([2]);
    expect(store.resultsFor(job.id)).toContainEqual({
      lineNumber: 3,
      status: "skipped",
      fingerprint: "f".repeat(64),
      errorCode: "duplicate_suggestion",
      errorMessage: "Duplicata provável não confirmada.",
    });
  });

  it("encaminha a chave de idempotência ao store ao cancelar", async () => {
    const calls: unknown[] = [];
    const job = { id: "job-cancel", workspaceId, state: "cancel_requested" } as ImportJobRecord;
    const store = {
      requestCancel: async (...args: unknown[]) => {
        calls.push(args);
        return job;
      },
    } as unknown as ImportStore;
    const app = new ImportApplication(store, source([]), new MemoryCommands());
    const requester = { actorId, correlationId: "corr-cancel", origin: "api" as const };

    await expect(app.cancel(job.id, workspaceId, requester, "cancel-key-123456")).resolves.toBe(
      job,
    );
    expect(calls).toEqual([[job.id, workspaceId, requester, "cancel-key-123456"]]);
  });

  it("persiste e reproduz o cancelamento idempotente no store PostgreSQL", async () => {
    const row = {
      id: "job-cancel-pg",
      workspace_id: workspaceId,
      actor_id: actorId,
      job_id: "worker-job",
      idempotency_key: "import-create-key",
      required_capability: "import" as const,
      domain: "products" as const,
      storage_key: "dev/input.csv",
      source_hash: "a".repeat(64),
      mapping_version: "products-v1",
      preview_hash: "b".repeat(64),
      preview_manifest: [],
      mode: "valid_only" as const,
      duplicate_policy: "skip" as const,
      accepted_duplicate_lines: [],
      total_rows: 0,
      valid_rows: 0,
      duplicate_rows: 0,
      invalid_rows: 0,
      applied_rows: 0,
      skipped_rows: 0,
      rejected_rows: 0,
      cursor: 0,
      batch_size: 100,
      state: "queued" as "queued" | "cancel_requested",
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
      last_error: null,
      version: 0,
      correlation_id: "corr-create",
    };
    let idempotencyHash: string | undefined;
    let idempotencyResponse: unknown;
    let transitionCalls = 0;
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("set_config")) return { rows: [] };
        if (sql.includes('DELETE FROM "idempotency_key"')) return { rows: [] };
        if (sql.includes('INSERT INTO "idempotency_key"')) {
          if (idempotencyHash !== undefined) return { rowCount: 0, rows: [] };
          idempotencyHash = String(values?.[2]);
          return { rowCount: 1, rows: [{ id: "cancel-idempotency" }] };
        }
        if (sql.includes("SELECT request_hash, status_code, response")) {
          return {
            rows: [
              { request_hash: idempotencyHash, status_code: 202, response: idempotencyResponse },
            ],
          };
        }
        if (sql.includes('UPDATE "import_job"')) {
          transitionCalls += 1;
          row.state = "cancel_requested";
          row.version += 1;
          return { rows: [row] };
        }
        if (sql.includes('SELECT * FROM "import_job"')) return { rows: [row] };
        if (sql.includes("INSERT INTO audit_event")) return { rows: [] };
        if (sql.includes('UPDATE "idempotency_key"')) {
          idempotencyResponse = values?.[3];
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const store = new PostgresImportStore({ connect: vi.fn(async () => client) } as never);
    const requester = { actorId, correlationId: "corr-cancel", origin: "api" as const };

    const first = await store.requestCancel(row.id, workspaceId, requester, "cancel-key-123456");
    const second = await store.requestCancel(row.id, workspaceId, requester, "cancel-key-123456");

    expect(first.state).toBe("cancel_requested");
    expect(second).toEqual(first);
    expect(transitionCalls).toBe(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "idempotency_key"'),
      expect.arrayContaining(["cancel-key-123456"]),
    );
  });

  it("permite que o store reproduza um retry idempotente após o job já estar enfileirado", async () => {
    const calls: unknown[] = [];
    const queuedJob = { id: "job-retry", workspaceId, state: "queued" } as ImportJobRecord;
    const store = {
      getJob: async () => queuedJob,
      retry: async (...args: unknown[]) => {
        calls.push(args);
        return queuedJob;
      },
    } as unknown as ImportStore;
    const app = new ImportApplication(store, source([]), new MemoryCommands());

    await expect(
      app.retry(
        queuedJob.id,
        workspaceId,
        { actorId, correlationId: "corr-retry", origin: "api" },
        "retry-key-123456",
      ),
    ).resolves.toBe(queuedJob);
    expect(calls[0]).toEqual([
      queuedJob.id,
      workspaceId,
      { actorId, correlationId: "corr-retry", origin: "api" },
      "retry-key-123456",
    ]);
  });

  it("propaga o lease de execução para cada lote e renova antes da leitura", async () => {
    const store = new MemoryStore();
    const commands = new MemoryCommands();
    let renewals = 0;
    const execution: JobExecutionContext = {
      runBatch: async (callback) =>
        callback({
          client: {} as never,
          beforeTransition: async () => undefined,
          renewLease: async () => true,
        }),
      renewLease: async () => {
        renewals += 1;
        return true;
      },
    };
    const app = new ImportApplication(store, source(rows()), commands, { batchSize: 3 });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-lease",
      request: baseRequest,
    });

    await app.run(job.id, workspaceId, execution);

    expect(store.lastExecution).toBe(execution);
    expect(renewals).toBeGreaterThan(0);
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
    const reversed = await app.reverse(job.id, workspaceId, {
      actorId: "requester-2",
      correlationId: "corr-reverse-request",
      origin: "api",
    });

    expect(reversed.state).toBe("reversed");
    expect(commands.reversed.map((row) => row.idempotencyKey)).toEqual([
      `import-reverse:${job.id}:2`,
      `import-reverse:${job.id}:4`,
    ]);
    expect(commands.reversed.every((row) => row.actorId === "requester-2")).toBe(true);
    expect(store.resultsFor(job.id).filter((row) => row.status === "reversed")).toHaveLength(2);
  });

  it("consulta resultados de linhas com cursor estável", async () => {
    const store = new MemoryStore();
    const app = new ImportApplication(store, source(rows()), new MemoryCommands(), {
      batchSize: 3,
    });
    const job = await app.create({
      workspaceId,
      actorId,
      correlationId: "corr-results",
      request: baseRequest,
    });
    await app.run(job.id, workspaceId);

    const firstPage = await app.listResults(job.id, workspaceId, undefined, 1);
    expect(firstPage.items[0]?.lineNumber).toBe(2);
    expect(firstPage.nextAfterLine).toBe(2);
    const secondPage = await app.listResults(
      job.id,
      workspaceId,
      firstPage.nextAfterLine ?? undefined,
      2,
    );
    expect(secondPage.items.map((line) => line.lineNumber)).toEqual([3, 4]);
    expect(secondPage.nextAfterLine).toBeNull();
  });
});
