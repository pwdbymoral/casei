import type {
  ImportCreateRequest,
  ImportDomain,
  ImportDuplicatePolicy,
  ImportJobState,
  ImportMode,
  ImportPreviewManifestLine,
} from "@casei/contracts";
import type { JobExecutionContext, Pool, PoolClient } from "@casei/database";
import {
  hashRequest,
  JobLeaseLostError,
  PostgresJobWorker,
  validateIdempotencyKey,
  withUnitOfWork,
} from "@casei/database";

/** A row produced by DATA-003. Values are already normalized and safe to pass to a domain command. */
export interface ImportSourceRow {
  readonly lineNumber: number;
  readonly status: "valid" | "duplicate" | "invalid";
  /** Digest of the normalized source row captured by the preflight manifest. */
  readonly rowDigest: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly errors?: readonly { readonly code: string; readonly message: string }[];
}

export interface ImportJobRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly requiredCapability: "import";
  readonly idempotencyKey: string;
  readonly domain: ImportDomain;
  readonly storageKey: string;
  readonly sourceHash: string;
  readonly mappingVersion: string;
  readonly previewHash: string;
  readonly previewManifest: readonly ImportPreviewManifestLine[];
  readonly mode: ImportMode;
  readonly duplicatePolicy: ImportDuplicatePolicy;
  readonly acceptedDuplicateLines: readonly number[];
  readonly totalRows: number;
  readonly validRows: number;
  readonly duplicateRows: number;
  readonly invalidRows: number;
  readonly appliedRows: number;
  readonly skippedRows: number;
  readonly rejectedRows: number;
  readonly cursor: number;
  readonly batchSize: number;
  readonly state: ImportJobState;
  readonly expiresAt: string;
  readonly version: number;
  readonly correlationId: string;
}

export interface ImportAppliedResult {
  readonly targetType: string;
  readonly targetId: string;
  /** Opaque, redacted command data used by the adapter to compensate a row. */
  readonly reversalToken?: string;
}

export interface ImportLineResult {
  readonly lineNumber: number;
  readonly status: "applied" | "skipped" | "rejected" | "reversed";
  readonly fingerprint?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly reversalToken?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ImportCommandContext {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly domain: ImportDomain;
  readonly lineNumber: number;
  /** Stable per-line key. A retry must pass the same key to the domain command. */
  readonly idempotencyKey: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  /** Shared UoW supplied by the store; adapters must use it for atomic batches. */
  readonly transaction?: unknown;
}

export interface ImportReverseContext {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly domain: ImportDomain;
  readonly lineNumber: number;
  readonly idempotencyKey: string;
  readonly applied: ImportLineResult;
  readonly transaction?: unknown;
}

/** Domain commands stay behind this port: the importer never writes ledger/stock tables directly. */
export interface ImportCommandPort {
  apply(context: ImportCommandContext): Promise<ImportAppliedResult>;
  reverse(context: ImportReverseContext): Promise<void>;
  /** Runs all commands in one domain transaction; it must roll back on callback failure. */
  runAtomicBatch(
    context: Pick<
      ImportCommandContext,
      "jobId" | "workspaceId" | "actorId" | "domain" | "transaction"
    >,
    callback: (
      apply: (context: ImportCommandContext) => Promise<ImportAppliedResult>,
    ) => Promise<void>,
  ): Promise<void>;
}

export interface ImportBatchContext {
  readonly job: ImportJobRecord;
  readonly rows: readonly ImportSourceRow[];
  readonly transaction?: unknown;
  /** Extends the worker lease inside the current fenced transaction. */
  renewLease(): Promise<boolean>;
  /** Re-checks membership, capability, expiry and job state while holding the batch lock. */
  assertAuthorized(): Promise<void>;
  findLineResult(lineNumber: number): Promise<ImportLineResult | null>;
  recordLine(result: ImportLineResult): Promise<void>;
  advance(cursor: number, counts: ImportCountDelta): Promise<void>;
  complete(): Promise<void>;
}

export interface ImportCountDelta {
  readonly appliedRows?: number;
  readonly skippedRows?: number;
  readonly rejectedRows?: number;
}

export interface ImportReverseBatchContext {
  readonly job: ImportJobRecord;
  readonly rows: readonly ImportLineResult[];
  readonly requester?: ImportRequester;
  readonly transaction?: unknown;
  assertAuthorized(): Promise<void>;
  recordLine(result: ImportLineResult): Promise<void>;
  complete(): Promise<void>;
}

export interface ImportRequester {
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly origin: "api" | "worker" | "system";
}

export interface ImportLineResultsPage {
  readonly items: readonly ImportLineResult[];
  readonly nextAfterLine: number | null;
}

export interface ImportStore {
  createJob(input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly request: ImportCreateRequest;
    readonly idempotencyKey: string;
    readonly batchSize: number;
  }): Promise<ImportJobRecord>;
  getJob(jobId: string, workspaceId: string): Promise<ImportJobRecord | null>;
  runBatch<T>(
    jobId: string,
    workspaceId: string,
    rows: readonly ImportSourceRow[],
    callback: (context: ImportBatchContext) => Promise<T>,
    execution?: JobExecutionContext,
  ): Promise<T>;
  runReverseBatch<T>(
    jobId: string,
    workspaceId: string,
    callback: (context: ImportReverseBatchContext) => Promise<T>,
    requester?: ImportRequester,
  ): Promise<T>;
  listLineResults(
    jobId: string,
    workspaceId: string,
    afterLine: number | undefined,
    limit: number,
  ): Promise<ImportLineResultsPage>;
  requestCancel(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord>;
  markCancelled(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord>;
  fail(
    jobId: string,
    workspaceId: string,
    error: ImportFailure,
    execution?: JobExecutionContext,
  ): Promise<void>;
}

export class ImportAuthorizationError extends Error {
  readonly code = "import_authorization_revoked" as const;

  constructor() {
    super("A autorização para continuar a importação não está mais válida.");
    this.name = "ImportAuthorizationError";
  }
}

export class ImportConflictError extends Error {
  readonly code = "import_conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "ImportConflictError";
  }
}

export class ImportFailure extends Error {
  readonly code = "import_failed" as const;

  readonly failureCause: unknown;

  constructor(message: string, failureCause?: unknown) {
    super(message);
    this.name = "ImportFailure";
    this.failureCause = failureCause;
  }
}

export interface ImportApplicationOptions {
  readonly batchSize?: number;
}

export function createImportPreviewHash(manifest: readonly ImportPreviewManifestLine[]): string {
  return hashRequest(manifest);
}

/** Orchestrates preflight rows into durable, idempotent domain commands. */
export class ImportApplication {
  private readonly batchSize: number;

  constructor(
    private readonly store: ImportStore,
    private readonly source: ImportSource,
    private readonly commands: ImportCommandPort,
    options: ImportApplicationOptions = {},
  ) {
    const batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
      throw new RangeError("O lote de importação deve ter entre 1 e 50000 linhas.");
    }
    this.batchSize = batchSize;
  }

  getJob(jobId: string, workspaceId: string): Promise<ImportJobRecord | null> {
    return this.store.getJob(jobId, workspaceId);
  }

  async create(input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly request: ImportCreateRequest;
    readonly idempotencyKey?: string;
  }): Promise<ImportJobRecord> {
    if (input.request.invalidRows > 0 && input.request.mode === "all_or_nothing") {
      throw new ImportConflictError("O modo tudo ou nada exige uma prévia sem erros.");
    }
    if (
      input.request.totalRows !==
      input.request.validRows + input.request.duplicateRows + input.request.invalidRows
    ) {
      throw new ImportConflictError("As contagens da prévia não conferem.");
    }
    if (input.request.previewManifest.length !== input.request.totalRows) {
      throw new ImportConflictError("O manifesto da prévia não cobre todas as linhas.");
    }
    if (createImportPreviewHash(input.request.previewManifest) !== input.request.previewHash) {
      throw new ImportConflictError("O manifesto da prévia não corresponde ao hash confirmado.");
    }
    const manifestLines = new Set<number>();
    let manifestValidRows = 0;
    let manifestDuplicateRows = 0;
    let manifestInvalidRows = 0;
    for (const line of input.request.previewManifest) {
      if (
        manifestLines.has(line.lineNumber) ||
        line.lineNumber < 2 ||
        line.lineNumber > input.request.totalRows + 1
      ) {
        throw new ImportConflictError("As linhas do manifesto da prévia são inválidas.");
      }
      manifestLines.add(line.lineNumber);
      if (line.status === "valid") manifestValidRows += 1;
      if (line.status === "duplicate") manifestDuplicateRows += 1;
      if (line.status === "invalid") manifestInvalidRows += 1;
    }
    if (
      manifestValidRows !== input.request.validRows ||
      manifestDuplicateRows !== input.request.duplicateRows ||
      manifestInvalidRows !== input.request.invalidRows
    ) {
      throw new ImportConflictError("As contagens do manifesto da prévia não conferem.");
    }
    const duplicateLines = input.request.acceptedDuplicateLines;
    const duplicateManifestLines = new Set(
      input.request.previewManifest
        .filter((line) => line.status === "duplicate")
        .map((line) => line.lineNumber),
    );
    if (
      new Set(duplicateLines).size !== duplicateLines.length ||
      duplicateLines.some(
        (line) =>
          line < 2 || line > input.request.totalRows + 1 || !duplicateManifestLines.has(line),
      )
    ) {
      throw new ImportConflictError("As linhas de duplicata confirmadas são inválidas.");
    }
    if (
      input.request.duplicatePolicy === "review" &&
      input.request.acceptedDuplicateLines.length === 0
    ) {
      // The job may still contain duplicates, but no duplicate can be imported by accident.
      // They will be reported as skipped until the caller confirms individual lines.
    }
    const expiresAt = Date.parse(input.request.expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 24 * 60 * 60 * 1_000
    ) {
      throw new ImportConflictError("O arquivo temporário deve expirar em até 24 horas.");
    }
    const idempotencyKey = input.idempotencyKey ?? `import-create:${input.request.previewHash}`;
    validateIdempotencyKey(idempotencyKey);
    return this.store.createJob({
      ...input,
      idempotencyKey,
      // all_or_nothing is a job-wide guarantee. One durable transaction must
      // contain every row, so the persisted batch cannot split this mode.
      batchSize:
        input.request.mode === "all_or_nothing"
          ? Math.max(this.batchSize, input.request.totalRows)
          : this.batchSize,
    });
  }

  async run(
    jobId: string,
    workspaceId: string,
    execution?: JobExecutionContext,
  ): Promise<ImportJobRecord> {
    let job = await this.store.getJob(jobId, workspaceId);
    if (!job) throw new ImportConflictError("Importação não encontrada.");
    if (["succeeded", "cancelled", "reversed"].includes(job.state)) return job;
    if (job.state === "cancel_requested") {
      return this.store.markCancelled(jobId, workspaceId, systemRequester(job, "worker"));
    }

    const ensureLease = async (): Promise<void> => {
      if (!execution) return;
      if (!(await execution.renewLease())) throw new JobLeaseLostError();
    };

    try {
      while (true) {
        let terminal = false;
        await ensureLease();
        const sourceRows = await this.source.readBatch({
          storageKey: job.storageKey,
          sourceHash: job.sourceHash,
          mappingVersion: job.mappingVersion,
          previewHash: job.previewHash,
          previewManifest: job.previewManifest,
          cursor: job.cursor,
          limit: job.batchSize,
          expiresAt: job.expiresAt,
        });
        await this.store.runBatch(
          jobId,
          workspaceId,
          sourceRows,
          async (batch) => {
            await batch.assertAuthorized();
            if (batch.job.state === "cancel_requested" || batch.job.state === "cancelled") {
              terminal = true;
              return;
            }
            if (batch.rows.length === 0) {
              if (batch.job.cursor < batch.job.totalRows) {
                throw new ImportFailure("A fonte da importação terminou antes de todas as linhas.");
              }
              await batch.complete();
              terminal = true;
              return;
            }
            if (
              batch.rows.length > batch.job.batchSize ||
              batch.job.cursor + batch.rows.length > batch.job.totalRows
            ) {
              throw new ImportFailure("A fonte da importação excede a prévia confirmada.");
            }
            assertPreviewRows(batch.job, batch.rows, batch.job.cursor);
            if (
              batch.job.mode === "all_or_nothing" &&
              (batch.job.cursor !== 0 || batch.rows.length !== batch.job.totalRows)
            ) {
              throw new ImportFailure(
                "A fonte não entregou o job completo em uma única transação tudo ou nada.",
              );
            }

            let appliedRows = 0;
            let skippedRows = 0;
            let rejectedRows = 0;
            let rowsSinceLeaseRenewal = 0;
            const processRows = async (
              apply: (context: ImportCommandContext) => Promise<ImportAppliedResult>,
            ): Promise<void> => {
              for (const row of batch.rows) {
                rowsSinceLeaseRenewal += 1;
                if (rowsSinceLeaseRenewal >= 100) {
                  if (!(await batch.renewLease())) throw new JobLeaseLostError();
                  rowsSinceLeaseRenewal = 0;
                }
                const existing = await batch.findLineResult(row.lineNumber);
                if (existing) continue;
                if (row.status === "invalid") {
                  if (batch.job.mode === "all_or_nothing") {
                    throw new ImportFailure("A fonte divergiu da prévia no modo tudo ou nada.");
                  }
                  await batch.recordLine({
                    lineNumber: row.lineNumber,
                    status: "rejected",
                    fingerprint: row.fingerprint,
                    errorCode: row.errors?.[0]?.code ?? "invalid_row",
                    errorMessage: row.errors?.[0]?.message ?? "A linha foi rejeitada na prévia.",
                  });
                  rejectedRows += 1;
                  continue;
                }
                const duplicate = row.status === "duplicate";
                const shouldImportDuplicate =
                  !duplicate ||
                  batch.job.duplicatePolicy === "import" ||
                  (batch.job.duplicatePolicy === "review" &&
                    batch.job.acceptedDuplicateLines.includes(row.lineNumber));
                if (!shouldImportDuplicate) {
                  await batch.recordLine({
                    lineNumber: row.lineNumber,
                    status: "skipped",
                    fingerprint: row.fingerprint,
                    errorCode: duplicate ? "duplicate_suggestion" : undefined,
                    errorMessage: duplicate ? "Duplicata provável não confirmada." : undefined,
                  });
                  skippedRows += 1;
                  continue;
                }
                if (!row.values) {
                  throw new ImportFailure("A linha válida não possui valores normalizados.");
                }
                try {
                  const command = {
                    jobId: batch.job.id,
                    workspaceId: batch.job.workspaceId,
                    actorId: batch.job.actorId,
                    domain: batch.job.domain,
                    lineNumber: row.lineNumber,
                    idempotencyKey: lineIdempotencyKey(batch.job.id, row.lineNumber),
                    values: row.values,
                    fingerprint: row.fingerprint,
                    transaction: batch.transaction,
                  } satisfies ImportCommandContext;
                  const applied = await apply(command);
                  await batch.recordLine({
                    lineNumber: row.lineNumber,
                    status: "applied",
                    fingerprint: row.fingerprint,
                    targetType: applied.targetType,
                    targetId: applied.targetId,
                    reversalToken: applied.reversalToken,
                  });
                  appliedRows += 1;
                } catch (error) {
                  if (batch.job.mode === "all_or_nothing") throw error;
                  await batch.recordLine({
                    lineNumber: row.lineNumber,
                    status: "rejected",
                    fingerprint: row.fingerprint,
                    errorCode: "command_failed",
                    errorMessage: safeFailureMessage(error),
                  });
                  rejectedRows += 1;
                }
              }
            };
            if (batch.job.mode === "all_or_nothing") {
              await this.commands.runAtomicBatch(
                {
                  jobId: batch.job.id,
                  workspaceId: batch.job.workspaceId,
                  actorId: batch.job.actorId,
                  domain: batch.job.domain,
                  transaction: batch.transaction,
                },
                processRows,
              );
            } else {
              await processRows((command) => this.commands.apply(command));
            }
            await batch.advance(batch.job.cursor + batch.rows.length, {
              appliedRows,
              skippedRows,
              rejectedRows,
            });
          },
          execution,
        );
        job = (await this.store.getJob(jobId, workspaceId)) ?? job;
        if (terminal) return job;
      }
    } catch (error) {
      if (error instanceof JobLeaseLostError) throw error;
      if (error instanceof ImportAuthorizationError) {
        const requester = systemRequester(job, "worker");
        await this.store.requestCancel(jobId, workspaceId, requester);
        return this.store.markCancelled(jobId, workspaceId, requester);
      }
      await this.store.fail(
        jobId,
        workspaceId,
        error instanceof ImportFailure ? error : new ImportFailure("A aplicação falhou.", error),
        execution,
      );
      throw error;
    }
  }

  async cancel(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord> {
    return this.store.requestCancel(jobId, workspaceId, requester);
  }

  async reverse(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord> {
    let job = await this.store.getJob(jobId, workspaceId);
    if (!job) throw new ImportConflictError("Importação não encontrada.");
    if (job.state === "reversed") return job;
    if (!["succeeded", "cancelled", "failed"].includes(job.state)) {
      throw new ImportConflictError("A importação precisa terminar antes de ser revertida.");
    }
    try {
      while (true) {
        let complete = false;
        await this.store.runReverseBatch(
          jobId,
          workspaceId,
          async (batch) => {
            await batch.assertAuthorized();
            if (batch.rows.length === 0) {
              await batch.complete();
              complete = true;
              return;
            }
            for (const applied of batch.rows) {
              if (applied.status !== "applied") continue;
              await this.commands.reverse({
                jobId: batch.job.id,
                workspaceId: batch.job.workspaceId,
                actorId: batch.requester?.actorId ?? batch.job.actorId,
                domain: batch.job.domain,
                lineNumber: applied.lineNumber,
                idempotencyKey: reverseLineIdempotencyKey(batch.job.id, applied.lineNumber),
                applied,
                transaction: batch.transaction,
              });
              await batch.recordLine({ ...applied, status: "reversed" });
            }
          },
          requester,
        );
        job = (await this.store.getJob(jobId, workspaceId)) ?? job;
        if (complete) return job;
      }
    } catch (error) {
      await this.store.fail(jobId, workspaceId, new ImportFailure("A reversão falhou.", error));
      throw error;
    }
  }

  listResults(
    jobId: string,
    workspaceId: string,
    afterLine: number | undefined,
    limit: number,
  ): Promise<ImportLineResultsPage> {
    return this.store.listLineResults(jobId, workspaceId, afterLine, limit);
  }
}

export interface ImportSource {
  readBatch(input: {
    readonly storageKey: string;
    readonly sourceHash: string;
    readonly mappingVersion: string;
    readonly previewHash: string;
    readonly previewManifest: readonly ImportPreviewManifestLine[];
    readonly cursor: number;
    readonly limit: number;
    readonly expiresAt: string;
  }): Promise<readonly ImportSourceRow[]>;
}

/** PostgreSQL adapter used by the worker/API. Binary source bytes remain in the storage port. */
export class PostgresImportStore implements ImportStore {
  constructor(
    private readonly pool: Pool,
    private readonly applicationRole?: string,
  ) {}

  async createJob(input: Parameters<ImportStore["createJob"]>[0]): Promise<ImportJobRecord> {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const existing = await client.query<ImportJobRow>(
          `SELECT * FROM "import_job"
           WHERE workspace_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [input.workspaceId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const existingJob = mapImportJob(existing.rows[0]);
          assertImportRequestMatches(existingJob, input.request);
          return existingJob;
        }

        const created = await client.query<{ id: string }>(
          `INSERT INTO "import_job"
             (workspace_id, actor_id, required_capability, domain, storage_key, source_hash,
              idempotency_key,
              mapping_version, preview_hash, preview_manifest, mode, duplicate_policy, accepted_duplicate_lines,
              total_rows, valid_rows, duplicate_rows, invalid_rows, batch_size, expires_at, correlation_id)
           VALUES ($1, $2, 'import', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb,
                   $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            input.workspaceId,
            input.actorId,
            input.request.domain,
            input.request.storageKey,
            input.request.sourceHash,
            input.idempotencyKey,
            input.request.mappingVersion,
            input.request.previewHash,
            JSON.stringify(input.request.previewManifest),
            input.request.mode,
            input.request.duplicatePolicy,
            JSON.stringify(input.request.acceptedDuplicateLines),
            input.request.totalRows,
            input.request.validRows,
            input.request.duplicateRows,
            input.request.invalidRows,
            input.batchSize,
            input.request.expiresAt,
            input.correlationId,
          ],
        );
        if (!created.rows[0]) {
          const concurrent = await client.query<ImportJobRow>(
            `SELECT * FROM "import_job"
             WHERE workspace_id = $1 AND idempotency_key = $2`,
            [input.workspaceId, input.idempotencyKey],
          );
          if (concurrent.rows[0]) {
            const concurrentJob = mapImportJob(concurrent.rows[0]);
            assertImportRequestMatches(concurrentJob, input.request);
            return concurrentJob;
          }
        }
        const importJobId = created.rows[0]?.id;
        if (!importJobId) throw new Error("Import job was not created.");
        const queued = await client.query<{ id: string }>(
          `INSERT INTO "job"
             (job_type, job_version, workspace_id, actor_id, required_capability,
              idempotency_key, payload, correlation_id)
           VALUES ('data.import', 1, $1, $2, 'import', $3, $4::jsonb, $5)
           ON CONFLICT (job_type, idempotency_key) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [
            input.workspaceId,
            input.actorId,
            `import:${input.workspaceId}:${input.idempotencyKey}`,
            JSON.stringify({ importJobId }),
            input.correlationId,
          ],
        );
        const jobId = queued.rows[0]?.id;
        if (!jobId) throw new Error("Import worker job was not queued.");
        const linked = await client.query<ImportJobRow>(
          `UPDATE "import_job" SET job_id = $2, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [importJobId, jobId],
        );
        const row = linked.rows[0];
        if (!row) throw new Error("Import job link was not persisted.");
        await client.query(
          `INSERT INTO audit_event
             (category, action, actor_id, workspace_id, target_type, target_id, origin,
              correlation_id, result, after_redacted)
           VALUES ('data', 'import.created', $1, $2, 'import_job', $3, 'api', $4, 'success', $5::jsonb)`,
          [
            input.actorId,
            input.workspaceId,
            importJobId,
            input.correlationId,
            JSON.stringify({
              domain: input.request.domain,
              totalRows: input.request.totalRows,
              sourceHash: input.request.sourceHash,
            }),
          ],
        );
        return mapImportJob(row);
      },
    );
  }

  async getJob(jobId: string, workspaceId: string): Promise<ImportJobRecord | null> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ImportJobRow>(
          `SELECT * FROM "import_job" WHERE id = $1 AND workspace_id = $2`,
          [jobId, workspaceId],
        );
        return result.rows[0] ? mapImportJob(result.rows[0]) : null;
      },
    );
  }

  async runBatch<T>(
    jobId: string,
    workspaceId: string,
    rows: readonly ImportSourceRow[],
    callback: (context: ImportBatchContext) => Promise<T>,
    execution?: JobExecutionContext,
  ): Promise<T> {
    const runWithClient = async (
      client: PoolClient,
      beforeTransition: () => Promise<void>,
      renewLease: () => Promise<boolean>,
    ): Promise<T> => {
      await beforeTransition();
      const result = await client.query<ImportJobRow>(
        `SELECT * FROM "import_job" WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [jobId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new ImportConflictError("Importação não encontrada.");
      const job = mapImportJob(row);
      if (job.cursor > job.totalRows)
        throw new ImportConflictError("Cursor de importação inválido.");
      if (job.state === "cancel_requested") {
        await client.query(
          `UPDATE "import_job" SET state = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`,
          [job.id],
        );
      }
      const context: ImportBatchContext = {
        job,
        rows,
        transaction: client,
        renewLease,
        assertAuthorized: async () => {
          await beforeTransition();
          await assertImportAuthorization(client, job);
        },
        findLineResult: async (lineNumber) => {
          const line = await client.query<ImportLineRow>(
            `SELECT line_number, status, fingerprint, target_type, target_id, reversal_token,
                      error_code, error_message
                 FROM "import_job_line" WHERE workspace_id = $1 AND job_id = $2 AND line_number = $3`,
            [job.workspaceId, job.id, lineNumber],
          );
          return line.rows[0] ? mapImportLine(line.rows[0]) : null;
        },
        recordLine: async (line) => {
          await client.query(
            `INSERT INTO "import_job_line"
                 (job_id, workspace_id, line_number, status, fingerprint, target_type,
                  target_id, reversal_token, error_code, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (job_id, line_number) DO UPDATE SET
                 status = EXCLUDED.status, fingerprint = EXCLUDED.fingerprint,
                 target_type = EXCLUDED.target_type, target_id = EXCLUDED.target_id,
                 reversal_token = EXCLUDED.reversal_token, error_code = EXCLUDED.error_code,
                 error_message = EXCLUDED.error_message, updated_at = now()`,
            [
              job.id,
              job.workspaceId,
              line.lineNumber,
              line.status,
              line.fingerprint ?? null,
              line.targetType ?? null,
              line.targetId ?? null,
              line.reversalToken ?? null,
              line.errorCode ?? null,
              line.errorMessage ?? null,
            ],
          );
        },
        advance: async (cursor, counts) => {
          await beforeTransition();
          const advanced = await client.query(
            `UPDATE "import_job"
                  SET cursor = $2, applied_rows = applied_rows + $3,
                      skipped_rows = skipped_rows + $4, rejected_rows = rejected_rows + $5,
                      state = 'running', version = version + 1, updated_at = now()
                WHERE id = $1 AND workspace_id = $6 AND cursor = $7`,
            [
              job.id,
              cursor,
              counts.appliedRows ?? 0,
              counts.skippedRows ?? 0,
              counts.rejectedRows ?? 0,
              job.workspaceId,
              job.cursor,
            ],
          );
          if (advanced.rowCount !== 1)
            throw new ImportConflictError("Cursor de importação conflitou.");
        },
        complete: async () => {
          await beforeTransition();
          await client.query(
            `UPDATE "import_job" SET state = 'succeeded', version = version + 1, updated_at = now()
                WHERE id = $1 AND workspace_id = $2 AND state IN ('queued', 'running', 'failed')`,
            [job.id, job.workspaceId],
          );
          await client.query(
            `INSERT INTO audit_event
                 (category, action, actor_id, workspace_id, target_type, target_id, origin,
                  correlation_id, result)
               VALUES ('data', 'import.completed', $1, $2, 'import_job', $3, 'worker', $4, 'success')`,
            [job.actorId, job.workspaceId, job.id, job.correlationId],
          );
        },
      };
      return callback(context);
    };
    if (execution) {
      return execution.runBatch(({ client, beforeTransition, renewLease }) =>
        runWithClient(client, beforeTransition, renewLease),
      );
    }
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) =>
        runWithClient(
          client,
          async () => undefined,
          async () => true,
        ),
    );
  }

  async runReverseBatch<T>(
    jobId: string,
    workspaceId: string,
    callback: (context: ImportReverseBatchContext) => Promise<T>,
    requester?: ImportRequester,
  ): Promise<T> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ImportJobRow>(
          `SELECT * FROM "import_job" WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [jobId, workspaceId],
        );
        const row = result.rows[0];
        if (!row) throw new ImportConflictError("Importação não encontrada.");
        const job = mapImportJob(row);
        const firstReversalBatch = job.state !== "reversing" && job.state !== "reversed";
        if (job.state !== "reversed") {
          await client.query(
            `UPDATE "import_job" SET state = 'reversing', version = version + 1, updated_at = now()
              WHERE id = $1 AND state IN ('succeeded', 'cancelled', 'failed', 'reversing')`,
            [job.id],
          );
        }
        if (firstReversalBatch) {
          const auditRequester = requester ?? systemRequester(job, "worker");
          await client.query(
            `INSERT INTO audit_event
               (category, action, actor_id, workspace_id, target_type, target_id, origin,
                correlation_id, result)
             VALUES ('data', 'import.reversal_requested', $1, $2, 'import_job', $3, $4, $5, 'success')`,
            [
              auditRequester.actorId,
              job.workspaceId,
              job.id,
              auditRequester.origin,
              auditRequester.correlationId,
            ],
          );
        }
        const lines = await client.query<ImportLineRow>(
          `SELECT line_number, status, fingerprint, target_type, target_id, reversal_token,
                  error_code, error_message
             FROM "import_job_line"
            WHERE job_id = $1 AND workspace_id = $2 AND status = 'applied'
            ORDER BY line_number ASC LIMIT $3 FOR UPDATE`,
          [job.id, job.workspaceId, job.batchSize],
        );
        const context: ImportReverseBatchContext = {
          job: { ...job, state: job.state === "reversed" ? "reversed" : "reversing" },
          rows: lines.rows.map(mapImportLine),
          requester,
          transaction: client,
          assertAuthorized: () =>
            assertImportAuthorization(client, job, requester?.actorId ?? job.actorId),
          recordLine: async (line) => {
            await client.query(
              `UPDATE "import_job_line" SET status = $3, updated_at = now()
                WHERE job_id = $1 AND line_number = $2 AND status = 'applied'`,
              [job.id, line.lineNumber, line.status],
            );
          },
          complete: async () => {
            const completed = await client.query(
              `UPDATE "import_job" SET state = 'reversed', version = version + 1, updated_at = now()
                WHERE id = $1 AND workspace_id = $2 AND state = 'reversing'`,
              [job.id, job.workspaceId],
            );
            if (completed.rowCount !== 1) return;
            const auditRequester = requester ?? systemRequester(job, "worker");
            await client.query(
              `INSERT INTO audit_event
                 (category, action, actor_id, workspace_id, target_type, target_id, origin,
                  correlation_id, result)
               VALUES ('data', 'import.reversal_completed', $1, $2, 'import_job', $3, $4, $5, 'success')`,
              [
                auditRequester.actorId,
                job.workspaceId,
                job.id,
                auditRequester.origin,
                auditRequester.correlationId,
              ],
            );
          },
        };
        return callback(context);
      },
    );
  }

  async listLineResults(
    jobId: string,
    workspaceId: string,
    afterLine: number | undefined,
    limit: number,
  ): Promise<ImportLineResultsPage> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const job = await client.query<{ id: string }>(
          `SELECT id FROM "import_job" WHERE id = $1 AND workspace_id = $2`,
          [jobId, workspaceId],
        );
        if (!job.rows[0]) throw new ImportConflictError("Importação não encontrada.");
        const lines = await client.query<ImportLineRow>(
          `SELECT line_number, status, fingerprint, target_type, target_id, reversal_token,
                  error_code, error_message
             FROM "import_job_line"
            WHERE workspace_id = $1 AND job_id = $2 AND ($3::integer IS NULL OR line_number > $3)
            ORDER BY line_number ASC
            LIMIT $4`,
          [workspaceId, jobId, afterLine ?? null, limit + 1],
        );
        const hasNext = lines.rows.length > limit;
        const items = (hasNext ? lines.rows.slice(0, limit) : lines.rows).map(mapImportLine);
        return {
          items,
          nextAfterLine: hasNext ? (items.at(-1)?.lineNumber ?? null) : null,
        };
      },
    );
  }

  async requestCancel(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord> {
    return this.transition(
      jobId,
      workspaceId,
      "cancel_requested",
      ["queued", "running"],
      requester,
    );
  }

  async markCancelled(
    jobId: string,
    workspaceId: string,
    requester?: ImportRequester,
  ): Promise<ImportJobRecord> {
    return this.transition(
      jobId,
      workspaceId,
      "cancelled",
      ["cancel_requested", "cancelled"],
      requester,
    );
  }

  async fail(
    jobId: string,
    workspaceId: string,
    error: ImportFailure,
    execution?: JobExecutionContext,
  ): Promise<void> {
    const update = async (client: PoolClient): Promise<void> => {
      await client.query(
        `UPDATE "import_job" SET state = 'failed', last_error = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND state NOT IN ('succeeded', 'cancelled', 'reversed')`,
        [jobId, workspaceId, safeFailureMessage(error)],
      );
    };
    if (execution) {
      await execution.runBatch(async ({ client, beforeTransition }) => {
        await beforeTransition();
        await update(client);
      });
      return;
    }
    await withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => update(client),
    );
  }

  private async transition(
    jobId: string,
    workspaceId: string,
    state: ImportJobState,
    from: readonly ImportJobState[],
    requester?: ImportRequester,
  ): Promise<ImportJobRecord> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ImportJobRow>(
          `UPDATE "import_job" SET state = $3, version = version + 1, updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND state = ANY($4::text[])
            RETURNING *`,
          [jobId, workspaceId, state, from],
        );
        if (!result.rows[0]) {
          const current = await client.query<ImportJobRow>(
            `SELECT * FROM "import_job" WHERE id = $1 AND workspace_id = $2`,
            [jobId, workspaceId],
          );
          if (!current.rows[0]) throw new ImportConflictError("Importação não encontrada.");
          return mapImportJob(current.rows[0]);
        }
        const auditRequester = requester ?? systemRequester(mapImportJob(result.rows[0]), "worker");
        await client.query(
          `INSERT INTO audit_event
             (category, action, actor_id, workspace_id, target_type, target_id, origin,
              correlation_id, result)
           VALUES ('data', $1, $2, $3, 'import_job', $4, $5, $6, 'success')`,
          [
            state === "cancel_requested" ? "import.cancel_requested" : "import.cancelled",
            auditRequester.actorId,
            result.rows[0].workspace_id,
            result.rows[0].id,
            auditRequester.origin,
            auditRequester.correlationId,
          ],
        );
        return mapImportJob(result.rows[0]);
      },
    );
  }
}

/** Registers the durable worker handler without starting a worker in the API process. */
export function createImportWorker(input: {
  readonly pool: Pool;
  readonly source: ImportSource;
  readonly commands: ImportCommandPort;
  readonly applicationRole?: string;
  readonly batchSize?: number;
}): PostgresJobWorker {
  const store = new PostgresImportStore(input.pool, input.applicationRole);
  const application = new ImportApplication(store, input.source, input.commands, {
    batchSize: input.batchSize,
  });
  return new PostgresJobWorker(
    input.pool,
    new Map([
      [
        "data.import:1",
        async (job, execution) => {
          if (!job.workspaceId) throw new ImportAuthorizationError();
          const payload = parseImportJobPayload(job.payload);
          await application.run(payload.importJobId, job.workspaceId, execution);
        },
      ],
    ]),
    {
      applicationRole: input.applicationRole,
      authorizeCapability: ({ role, capability }) =>
        capability === "import" ? role === "owner" || role === "member" : role === "owner",
      onAuthorizationRevoked: async (job) => {
        if (!job.workspaceId) return;
        const payload = parseImportJobPayload(job.payload);
        const requester: ImportRequester = {
          actorId: null,
          correlationId: job.correlationId,
          origin: "worker",
        };
        await store.requestCancel(payload.importJobId, job.workspaceId, requester);
        await store.markCancelled(payload.importJobId, job.workspaceId, requester);
      },
    },
  );
}

function parseImportJobPayload(value: unknown): { importJobId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("importJobId" in value) ||
    typeof value.importJobId !== "string" ||
    value.importJobId.length === 0
  ) {
    throw new ImportFailure("O payload do job de importação é inválido.");
  }
  return { importJobId: value.importJobId };
}

interface ImportJobRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  job_id: string | null;
  idempotency_key: string;
  required_capability: "import";
  domain: ImportDomain;
  storage_key: string;
  source_hash: string;
  mapping_version: string;
  preview_hash: string;
  preview_manifest: unknown;
  mode: ImportMode;
  duplicate_policy: ImportDuplicatePolicy;
  accepted_duplicate_lines: unknown;
  total_rows: number;
  valid_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  applied_rows: number;
  skipped_rows: number;
  rejected_rows: number;
  cursor: number;
  batch_size: number;
  state: ImportJobState;
  expires_at: Date | string;
  version: number;
  correlation_id: string;
}

interface ImportLineRow {
  line_number: number;
  status: ImportLineResult["status"];
  fingerprint: string | null;
  target_type: string | null;
  target_id: string | null;
  reversal_token: string | null;
  error_code: string | null;
  error_message: string | null;
}

function mapImportJob(row: ImportJobRow): ImportJobRecord {
  const accepted = Array.isArray(row.accepted_duplicate_lines)
    ? row.accepted_duplicate_lines.filter((line): line is number => Number.isSafeInteger(line))
    : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    requiredCapability: "import",
    domain: row.domain,
    storageKey: row.storage_key,
    sourceHash: row.source_hash,
    mappingVersion: row.mapping_version,
    previewHash: row.preview_hash,
    previewManifest: Array.isArray(row.preview_manifest)
      ? row.preview_manifest.filter(isPreviewManifestLine)
      : [],
    mode: row.mode,
    duplicatePolicy: row.duplicate_policy,
    acceptedDuplicateLines: accepted,
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    duplicateRows: row.duplicate_rows,
    invalidRows: row.invalid_rows,
    appliedRows: row.applied_rows,
    skippedRows: row.skipped_rows,
    rejectedRows: row.rejected_rows,
    cursor: row.cursor,
    batchSize: row.batch_size,
    state: row.state,
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : new Date(row.expires_at).toISOString(),
    version: row.version,
    correlationId: row.correlation_id,
  };
}

function isPreviewManifestLine(value: unknown): value is ImportPreviewManifestLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(line.lineNumber) &&
    typeof line.status === "string" &&
    (line.status === "valid" || line.status === "duplicate" || line.status === "invalid") &&
    typeof line.rowDigest === "string" &&
    /^[a-f0-9]{64}$/.test(line.rowDigest) &&
    (line.fingerprint === undefined || typeof line.fingerprint === "string")
  );
}

function mapImportLine(row: ImportLineRow): ImportLineResult {
  return {
    lineNumber: row.line_number,
    status: row.status,
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    ...(row.target_type ? { targetType: row.target_type } : {}),
    ...(row.target_id ? { targetId: row.target_id } : {}),
    ...(row.reversal_token ? { reversalToken: row.reversal_token } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
  };
}

async function assertImportAuthorization(
  client: PoolClient,
  job: ImportJobRecord,
  actorId = job.actorId,
): Promise<void> {
  const workspace = await client.query<{ status: string }>(
    `SELECT status FROM "workspace" WHERE id = $1 FOR UPDATE`,
    [job.workspaceId],
  );
  if (workspace.rows[0]?.status !== "active") throw new ImportAuthorizationError();
  const membership = await client.query<{ status: string; role: string }>(
    `SELECT status, role FROM "membership" WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
    [job.workspaceId, actorId],
  );
  if (
    membership.rows[0]?.status !== "active" ||
    !["owner", "member"].includes(membership.rows[0].role)
  ) {
    throw new ImportAuthorizationError();
  }
  if (new Date(job.expiresAt).getTime() <= Date.now()) throw new ImportAuthorizationError();
}

function lineIdempotencyKey(jobId: string, lineNumber: number): string {
  return `import:${jobId}:${lineNumber}`;
}

function reverseLineIdempotencyKey(jobId: string, lineNumber: number): string {
  return `import-reverse:${jobId}:${lineNumber}`;
}

function systemRequester(
  job: Pick<ImportJobRecord, "correlationId">,
  origin: "worker" | "system",
): ImportRequester {
  return { actorId: null, correlationId: job.correlationId, origin };
}

function assertPreviewRows(
  job: ImportJobRecord,
  rows: readonly ImportSourceRow[],
  cursor: number,
): void {
  const manifest = new Map(job.previewManifest.map((line) => [line.lineNumber, line]));
  const expectedLineNumbers = new Set(
    job.previewManifest
      .filter(
        (line) => line.lineNumber >= cursor + 2 && line.lineNumber <= cursor + rows.length + 1,
      )
      .map((line) => line.lineNumber),
  );
  const seenLineNumbers = new Set<number>();
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.rowDigest)) {
      throw new ImportFailure("A fonte entregou uma linha sem digest válido.");
    }
    const expected = manifest.get(row.lineNumber);
    if (
      seenLineNumbers.has(row.lineNumber) ||
      !expected ||
      !expectedLineNumbers.has(row.lineNumber) ||
      expected.status !== row.status ||
      expected.rowDigest !== row.rowDigest ||
      (expected.fingerprint ?? null) !== (row.fingerprint ?? null)
    ) {
      throw new ImportFailure("A fonte divergiu do manifesto confirmado na prévia.");
    }
    seenLineNumbers.add(row.lineNumber);
  }
  if (seenLineNumbers.size !== expectedLineNumbers.size) {
    throw new ImportFailure("A fonte divergiu do manifesto confirmado na prévia.");
  }
}

function assertImportRequestMatches(existing: ImportJobRecord, request: ImportCreateRequest): void {
  const existingFingerprint = hashRequest({
    domain: existing.domain,
    storageKey: existing.storageKey,
    sourceHash: existing.sourceHash,
    mappingVersion: existing.mappingVersion,
    previewHash: existing.previewHash,
    previewManifest: existing.previewManifest,
    mode: existing.mode,
    duplicatePolicy: existing.duplicatePolicy,
    acceptedDuplicateLines: existing.acceptedDuplicateLines,
    totalRows: existing.totalRows,
    validRows: existing.validRows,
    duplicateRows: existing.duplicateRows,
    invalidRows: existing.invalidRows,
    expiresAt: new Date(existing.expiresAt).toISOString(),
  });
  const requestedFingerprint = hashRequest({
    domain: request.domain,
    storageKey: request.storageKey,
    sourceHash: request.sourceHash,
    mappingVersion: request.mappingVersion,
    previewHash: request.previewHash,
    previewManifest: request.previewManifest,
    mode: request.mode,
    duplicatePolicy: request.duplicatePolicy,
    acceptedDuplicateLines: request.acceptedDuplicateLines,
    totalRows: request.totalRows,
    validRows: request.validRows,
    duplicateRows: request.duplicateRows,
    invalidRows: request.invalidRows,
    expiresAt: new Date(request.expiresAt).toISOString(),
  });
  if (existingFingerprint !== requestedFingerprint) {
    throw new ImportConflictError(
      "A chave de idempotência já foi usada com uma prévia ou solicitação diferente.",
    );
  }
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof ImportFailure) return error.message;
  return "A linha não pôde ser aplicada.";
}
