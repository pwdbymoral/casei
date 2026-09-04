import { createHash } from "node:crypto";

import type { DataExchangeDomain, ExportCreateRequest, ExportJobResponse } from "@casei/contracts";
import { exportCreateRequestSchema } from "@casei/contracts";
import {
  type CsvExportColumn,
  type CsvExportRow,
  createVersionedCsvExport,
  createVersionedZipBundleExport,
  createVersionedZipExport,
} from "@casei/data";
import type { JobExecutionContext, Pool, PoolClient } from "@casei/database";
import {
  JobAuthorizationError,
  type JobRecord,
  PostgresJobWorker,
  withUnitOfWork,
} from "@casei/database";
import {
  createOpaqueStorageKey,
  type ObjectStoragePort,
  type StorageEnvironment,
} from "@casei/storage";
import type {
  DataExchangeDownload,
  DataExchangeExportApplication,
  DataExchangeExportContext,
} from "./data-exchange-routes.js";

const EXPORT_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const MAX_EXPORT_ROWS = 50_000;
const MAX_EXPORT_BYTES = 10_000_000;

export class ExportNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("Exportação não encontrada.");
    this.name = "ExportNotFoundError";
  }
}

export class ExportAuthorizationError extends Error {
  readonly code = "permission_denied" as const;
  constructor() {
    super("Você não tem permissão para esta exportação.");
    this.name = "ExportAuthorizationError";
  }
}

export class ExportConflictError extends Error {
  readonly code = "conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExportConflictError";
  }
}

export class ExportExpiredError extends Error {
  readonly code = "expired" as const;
  constructor() {
    super("Esta exportação expirou e precisa ser gerada novamente.");
    this.name = "ExportExpiredError";
  }
}

export class ExportFailure extends Error {
  readonly code = "export_failed" as const;
  constructor(
    message: string,
    readonly failureCause?: unknown,
  ) {
    super(message);
    this.name = "ExportFailure";
  }
}

export interface ExportJobRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requiredCapability: "export";
  readonly request: ExportCreateRequest;
  readonly fileName: string | null;
  readonly storageKey: string | null;
  readonly outputSha256: string | null;
  readonly outputBytes: number | null;
  readonly totalRows: number | null;
  readonly processedRows: number;
  readonly progress: number;
  readonly state: "queued" | "running" | "completed" | "failed" | "expired";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly version: number;
  readonly correlationId: string;
}

export interface ExportSourceFile {
  readonly domain: Exclude<DataExchangeDomain, "complete">;
  readonly schemaVersion: string;
  readonly columns: readonly CsvExportColumn[];
  readonly rows: Iterable<CsvExportRow>;
  readonly totalRows: number;
}

export interface ExportSourceResult {
  readonly timeZone: string;
  readonly currency: string;
  readonly files: readonly ExportSourceFile[];
}

export interface ExportSource {
  read(input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly request: ExportCreateRequest;
  }): Promise<ExportSourceResult>;
}

export interface ExportJobStore {
  create(input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly request: ExportCreateRequest;
    readonly idempotencyKey: string;
    readonly expiresAt: string;
    readonly fileName: string;
  }): Promise<ExportJobRecord>;
  list(workspaceId: string, limit: number): Promise<readonly ExportJobRecord[]>;
  get(id: string, workspaceId: string): Promise<ExportJobRecord | null>;
  markRunning(id: string, workspaceId: string): Promise<ExportJobRecord>;
  complete(
    id: string,
    workspaceId: string,
    input: {
      readonly storageKey: string;
      readonly outputSha256: string;
      readonly outputBytes: number;
      readonly totalRows: number;
    },
  ): Promise<ExportJobRecord>;
  fail(id: string, workspaceId: string, error: string): Promise<void>;
  expire(id: string, workspaceId: string, reason?: string): Promise<ExportJobRecord>;
  /** Records a successful authorized download without storing file contents. */
  recordDownload?(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly actorId: string;
    readonly correlationId: string;
  }): Promise<void>;
}

export interface ExportApplicationOptions {
  readonly environment: StorageEnvironment;
  readonly now?: () => Date;
}

/** Authorized export command/query boundary and worker-facing application service. */
export class ExportApplication implements DataExchangeExportApplication {
  private readonly now: () => Date;

  constructor(
    private readonly store: ExportJobStore,
    private readonly source: ExportSource,
    private readonly storage: ObjectStoragePort,
    private readonly options: ExportApplicationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(context: DataExchangeExportContext): Promise<readonly ExportJobResponse[]> {
    assertExportPermission(context.role);
    const jobs = await this.store.list(context.workspaceId, 100);
    return jobs
      .filter((job) => context.role === "owner" || job.request.domain !== "complete")
      .map(toExportJobResponse);
  }

  async create(
    context: DataExchangeExportContext & {
      readonly request: ExportCreateRequest;
      readonly idempotencyKey: string;
    },
  ): Promise<ExportJobResponse> {
    assertExportPermission(context.role, context.request);
    assertExportRequest(context.request);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + EXPORT_EXPIRY_MS).toISOString();
    const fileName = fileNameFor(context.request);
    const job = await this.store.create({ ...context, expiresAt, fileName });
    return toExportJobResponse(job);
  }

  async get(
    context: DataExchangeExportContext & { readonly exportId: string },
  ): Promise<ExportJobResponse> {
    assertExportPermission(context.role);
    const job = await this.store.get(context.exportId, context.workspaceId);
    if (!job) throw new ExportNotFoundError();
    assertExportPermission(context.role, job.request);
    return toExportJobResponse(job);
  }

  async download(
    context: DataExchangeExportContext & { readonly exportId: string },
  ): Promise<DataExchangeDownload> {
    assertExportPermission(context.role);
    const job = await this.store.get(context.exportId, context.workspaceId);
    if (!job) throw new ExportNotFoundError();
    assertExportPermission(context.role, job.request);
    if (job.state === "expired" || Date.parse(job.expiresAt) <= this.now().getTime()) {
      const expired = await this.store.expire(job.id, job.workspaceId);
      if (expired.storageKey) {
        await this.storage.delete({ key: expired.storageKey }).catch(() => undefined);
      }
      throw new ExportExpiredError();
    }
    if (job.state !== "completed" || !job.storageKey || !job.fileName) {
      throw new ExportConflictError("A exportação ainda não está pronta para download.");
    }
    const object = await this.storage.get({ key: job.storageKey, now: this.now() });
    if (
      object.sha256 !== job.outputSha256 ||
      object.contentLength !== job.outputBytes ||
      object.format !== job.request.format
    ) {
      throw new ExportFailure("O arquivo armazenado não corresponde à exportação registrada.");
    }
    await this.store.recordDownload?.({
      id: job.id,
      workspaceId: job.workspaceId,
      actorId: context.actorId,
      correlationId: context.correlationId,
    });
    return {
      body: object.stream,
      contentType: job.request.format === "zip" ? "application/zip" : "text/csv; charset=utf-8",
      fileName: job.fileName,
      contentLength: object.contentLength,
    };
  }

  /** Called only by the standalone worker after the generic job lease is held. */
  async run(jobId: string, workspaceId: string, execution?: JobExecutionContext): Promise<void> {
    const job = await this.store.get(jobId, workspaceId);
    if (!job) throw new ExportNotFoundError();
    if (job.state === "completed" || job.state === "expired") return;
    if (Date.parse(job.expiresAt) <= this.now().getTime()) {
      await this.store.expire(job.id, job.workspaceId, "export_expired_before_processing");
      return;
    }
    await this.store.markRunning(job.id, job.workspaceId);
    try {
      const source = await this.source.read({
        workspaceId: job.workspaceId,
        actorId: job.actorId,
        request: job.request,
      });
      const totalRows = source.files.reduce((total, file) => total + file.totalRows, 0);
      if (totalRows > MAX_EXPORT_ROWS) {
        throw new ExportFailure("A exportação excede o limite de 50.000 linhas.");
      }
      if (execution && !(await execution.renewLease())) throw new ExportFailure("Lease perdida.");
      const output = createExportOutput(job, source, this.now().toISOString());
      const bytes = await collectStream(output.stream, MAX_EXPORT_BYTES, execution?.renewLease);
      const outputSha256 = createHash("sha256").update(bytes).digest("hex");
      const storageKey = createOpaqueStorageKey({
        environment: this.options.environment,
        workspaceId: job.workspaceId,
        jobId: job.id,
        format: job.request.format,
      });
      let stored = false;
      try {
        await this.storage.put({
          key: storageKey,
          body: [bytes],
          contentLength: bytes.byteLength,
          contentType: output.contentType,
          format: job.request.format,
          expiresAt: job.expiresAt,
          sha256: outputSha256,
          now: this.now(),
        });
        stored = true;
        await output.manifest;
        const complete = () =>
          this.store.complete(job.id, job.workspaceId, {
            storageKey,
            outputSha256,
            outputBytes: bytes.byteLength,
            totalRows,
          });
        if (execution) {
          await execution.runBatch(async ({ beforeTransition }) => {
            await beforeTransition();
            await complete();
          });
        } else {
          await complete();
        }
      } catch (error) {
        if (stored) await this.storage.delete({ key: storageKey }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof JobAuthorizationError) throw error;
      const message = safeExportFailureMessage(error);
      await this.store.fail(job.id, job.workspaceId, message);
      throw error instanceof ExportFailure ? error : new ExportFailure(message, error);
    }
  }

  async expireRevoked(job: JobRecord): Promise<void> {
    if (!job.workspaceId) return;
    const payload = exportPayload(job.payload);
    const expired = await this.store.expire(
      payload.exportJobId,
      job.workspaceId,
      "export_authorization_revoked",
    );
    if (expired.storageKey) {
      await this.storage.delete({ key: expired.storageKey }).catch(() => undefined);
    }
  }
}

export function assertExportPermission(
  role: DataExchangeExportContext["role"],
  request?: ExportCreateRequest,
): void {
  if (request?.domain === "complete" && role !== "owner") throw new ExportAuthorizationError();
  if (role !== "owner" && role !== "member" && role !== "viewer")
    throw new ExportAuthorizationError();
}

function assertExportRequest(request: ExportCreateRequest): void {
  if (request.domain === "complete" && request.format !== "zip") {
    throw new ExportConflictError("A exportação completa precisa usar o formato ZIP.");
  }
  if (request.from && request.to && request.from > request.to) {
    throw new ExportConflictError("A data final deve ser igual ou posterior à inicial.");
  }
}

export function fileNameFor(request: ExportCreateRequest): string {
  if (request.domain === "complete") return "casei-completo.zip";
  return `${request.domain}.${request.format}`;
}

function createExportOutput(job: ExportJobRecord, source: ExportSourceResult, generatedAt: string) {
  const common = {
    schemaVersion: "1",
    generatedAt,
    timeZone: source.timeZone,
    currency: source.currency,
    filters: job.request,
  } as const;
  if (job.request.domain === "complete") {
    const files = source.files.map((file) =>
      createVersionedCsvExport({
        ...common,
        domain: file.domain,
        columns: file.columns,
        rows: file.rows,
        fileName: `${file.domain}.csv`,
      }),
    );
    return createVersionedZipBundleExport({
      ...common,
      domain: "complete",
      zipFileName: job.fileName ?? "casei-completo.zip",
      files,
    });
  }
  const file = source.files[0];
  if (!file) throw new ExportFailure("A fonte não retornou dados para exportação.");
  if (job.request.format === "zip") {
    return createVersionedZipExport({
      ...common,
      domain: job.request.domain,
      columns: file.columns,
      rows: file.rows,
      fileName: `${job.request.domain}.csv`,
      zipFileName: job.fileName ?? `${job.request.domain}.zip`,
    });
  }
  return createVersionedCsvExport({
    ...common,
    domain: file.domain,
    columns: file.columns,
    rows: file.rows,
    fileName: `${file.domain}.csv`,
  });
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  renewLease?: () => Promise<boolean>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let chunksSinceRenewal = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("export too large");
        throw new ExportFailure("A exportação excede o limite de 10 MB.");
      }
      chunks.push(next.value);
      chunksSinceRenewal += 1;
      if (renewLease && chunksSinceRenewal >= 16) {
        if (!(await renewLease())) {
          await reader.cancel("export lease lost");
          throw new ExportFailure("Lease perdida.");
        }
        chunksSinceRenewal = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function toExportJobResponse(job: ExportJobRecord): ExportJobResponse {
  const status = job.state === "running" ? "processing" : job.state;
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    domain: job.request.domain,
    format: job.request.format,
    status,
    progress: job.state === "completed" ? 100 : job.state === "expired" ? 100 : job.progress,
    fileName: job.fileName,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    ...(job.lastError ? { message: job.lastError } : {}),
  };
}

interface ExportJobRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  job_id: string | null;
  idempotency_key: string;
  required_capability: "export";
  request: unknown;
  file_name: string | null;
  storage_key: string | null;
  output_sha256: string | null;
  output_bytes: number | null;
  total_rows: number | null;
  processed_rows: number;
  progress: number;
  state: ExportJobRecord["state"];
  expires_at: Date | string;
  created_at: Date | string;
  completed_at: Date | string | null;
  last_error: string | null;
  version: number;
  correlation_id: string;
}

export class PostgresExportJobStore implements ExportJobStore {
  constructor(
    private readonly pool: Pool,
    private readonly applicationRole = "casei_app",
  ) {}

  async create(input: Parameters<ExportJobStore["create"]>[0]): Promise<ExportJobRecord> {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const existing = await client.query<ExportJobRow>(
          `SELECT * FROM "export_job" WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [input.workspaceId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const job = mapExportJob(existing.rows[0]);
          assertRequestMatches(job.request, input.request);
          return job;
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO "export_job"
             (workspace_id, actor_id, idempotency_key, required_capability, domain, format,
              request, file_name, expires_at, correlation_id)
           VALUES ($1, $2, $3, 'export', $4, $5, $6::jsonb, $7, $8, $9)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            input.workspaceId,
            input.actorId,
            input.idempotencyKey,
            input.request.domain,
            input.request.format,
            JSON.stringify(input.request),
            input.fileName,
            input.expiresAt,
            input.correlationId,
          ],
        );
        if (!inserted.rows[0]) {
          const concurrent = await client.query<ExportJobRow>(
            `SELECT * FROM "export_job" WHERE workspace_id = $1 AND idempotency_key = $2`,
            [input.workspaceId, input.idempotencyKey],
          );
          const job = concurrent.rows[0] && mapExportJob(concurrent.rows[0]);
          if (!job) throw new ExportFailure("O job de exportação não foi criado.");
          assertRequestMatches(job.request, input.request);
          return job;
        }
        const jobId = inserted.rows[0].id;
        const queued = await client.query<{ id: string }>(
          `INSERT INTO "job"
             (job_type, job_version, workspace_id, actor_id, required_capability,
              idempotency_key, payload, correlation_id)
           VALUES ('data.export', 1, $1, $2, 'export', $3, $4::jsonb, $5)
           RETURNING id`,
          [
            input.workspaceId,
            input.actorId,
            `export:${input.workspaceId}:${input.idempotencyKey}`,
            JSON.stringify({ exportJobId: jobId }),
            input.correlationId,
          ],
        );
        if (!queued.rows[0]) throw new ExportFailure("O job de exportação não foi enfileirado.");
        const linked = await client.query<ExportJobRow>(
          `UPDATE "export_job" SET job_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [jobId, queued.rows[0].id],
        );
        const row = linked.rows[0];
        if (!row) throw new ExportFailure("O vínculo do job de exportação não foi persistido.");
        await client.query(
          `INSERT INTO audit_event
             (category, action, actor_id, workspace_id, target_type, target_id, origin,
              correlation_id, result, after_redacted)
           VALUES ('data', 'export.created', $1, $2, 'export_job', $3, 'api', $4, 'success', $5::jsonb)`,
          [
            input.actorId,
            input.workspaceId,
            jobId,
            input.correlationId,
            JSON.stringify({ domain: input.request.domain, format: input.request.format }),
          ],
        );
        return mapExportJob(row);
      },
    );
  }

  async list(workspaceId: string, limit: number): Promise<readonly ExportJobRecord[]> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ExportJobRow>(
          `SELECT * FROM "export_job" WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
          [workspaceId, Math.min(Math.max(limit, 1), 100)],
        );
        return result.rows.map(mapExportJob);
      },
    );
  }

  async get(id: string, workspaceId: string): Promise<ExportJobRecord | null> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ExportJobRow>(
          `SELECT * FROM "export_job" WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        );
        return result.rows[0] ? mapExportJob(result.rows[0]) : null;
      },
    );
  }

  async markRunning(id: string, workspaceId: string): Promise<ExportJobRecord> {
    return this.transition(id, workspaceId, "running", ["queued", "failed"]);
  }

  async complete(
    id: string,
    workspaceId: string,
    input: Parameters<ExportJobStore["complete"]>[2],
  ): Promise<ExportJobRecord> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ExportJobRow>(
          `UPDATE "export_job"
              SET storage_key = $3, output_sha256 = $4, output_bytes = $5,
                  total_rows = $6, processed_rows = $6, progress = 100,
                  state = 'completed', completed_at = now(), version = version + 1,
                  updated_at = now(), last_error = NULL
            WHERE id = $1 AND workspace_id = $2 AND state IN ('queued', 'running', 'failed')
            RETURNING *`,
          [
            id,
            workspaceId,
            input.storageKey,
            input.outputSha256,
            input.outputBytes,
            input.totalRows,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          const current = await client.query<ExportJobRow>(
            `SELECT * FROM "export_job" WHERE id = $1 AND workspace_id = $2`,
            [id, workspaceId],
          );
          if (!current.rows[0]) throw new ExportNotFoundError();
          return mapExportJob(current.rows[0]);
        }
        return mapExportJob(row);
      },
    );
  }

  async fail(id: string, workspaceId: string, error: string): Promise<void> {
    await withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        await client.query(
          `UPDATE "export_job" SET state = 'failed', last_error = $3, version = version + 1, updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND state NOT IN ('completed', 'expired')`,
          [id, workspaceId, error.slice(0, 1_000)],
        );
      },
    );
  }

  async expire(
    id: string,
    workspaceId: string,
    reason = "export_expired",
  ): Promise<ExportJobRecord> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ExportJobRow>(
          `UPDATE "export_job" SET state = 'expired', progress = 100, last_error = $3,
                  version = version + 1, updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND state <> 'expired'
            RETURNING *`,
          [id, workspaceId, reason],
        );
        const row = result.rows[0];
        if (row) return mapExportJob(row);
        const current = await client.query<ExportJobRow>(
          `SELECT * FROM "export_job" WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        );
        if (!current.rows[0]) throw new ExportNotFoundError();
        return mapExportJob(current.rows[0]);
      },
    );
  }

  private async transition(
    id: string,
    workspaceId: string,
    state: ExportJobRecord["state"],
    from: readonly ExportJobRecord["state"][],
  ): Promise<ExportJobRecord> {
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.applicationRole },
      async ({ client }) => {
        const result = await client.query<ExportJobRow>(
          `UPDATE "export_job" SET state = $3, version = version + 1, updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND state = ANY($4::text[]) RETURNING *`,
          [id, workspaceId, state, from],
        );
        const row = result.rows[0];
        if (row) return mapExportJob(row);
        const current = await client.query<ExportJobRow>(
          `SELECT * FROM "export_job" WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        );
        if (!current.rows[0]) throw new ExportNotFoundError();
        return mapExportJob(current.rows[0]);
      },
    );
  }

  async recordDownload(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly actorId: string;
    readonly correlationId: string;
  }): Promise<void> {
    await withUnitOfWork(
      this.pool,
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        correlationId: input.correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        await client.query(
          `INSERT INTO audit_event
             (category, action, actor_id, workspace_id, target_type, target_id, origin,
              correlation_id, result, after_redacted)
           SELECT 'data', 'export.downloaded', $1, $2, 'export_job', $3, 'api', $4, 'success',
                  jsonb_build_object('format', format, 'domain', domain)
             FROM export_job
            WHERE id = $3 AND workspace_id = $2 AND state = 'completed'`,
          [input.actorId, input.workspaceId, input.id, input.correlationId],
        );
      },
    );
  }
}

export class PostgresExportSource implements ExportSource {
  constructor(
    private readonly pool: Pool,
    private readonly applicationRole = "casei_app",
  ) {}

  async read(input: Parameters<ExportSource["read"]>[0]): Promise<ExportSourceResult> {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const preference = await client.query<{ currency_code: string; timezone: string }>(
          `SELECT currency_code, timezone FROM workspace_preference WHERE workspace_id = $1`,
          [input.workspaceId],
        );
        const settings = preference.rows[0];
        if (!settings)
          throw new ExportFailure("As preferências do espaço ainda não foram configuradas.");
        const files: ExportSourceFile[] = [];
        if (input.request.domain === "transactions" || input.request.domain === "complete") {
          files.push({
            domain: "transactions",
            schemaVersion: "1",
            columns: transactionColumns,
            rows: await this.readTransactions(client, input),
            totalRows: await this.countTransactions(client, input),
          });
        }
        if (input.request.domain === "products" || input.request.domain === "complete") {
          files.push({
            domain: "products",
            schemaVersion: "1",
            columns: productColumns,
            rows: await this.readProducts(client, input.workspaceId),
            totalRows: await this.countProducts(client, input.workspaceId),
          });
        }
        return { timeZone: settings.timezone, currency: settings.currency_code, files };
      },
    );
  }

  private async readTransactions(
    client: PoolClient,
    input: Parameters<ExportSource["read"]>[0],
  ): Promise<readonly CsvExportRow[]> {
    const values: unknown[] = [input.workspaceId];
    const conditions = ["workspace_id = $1"];
    addTransactionFilters(input.request, conditions, values);
    const result = await client.query<TransactionRow>(
      `SELECT id, kind, amount_minor, occurred_on, state, description, category_id, due_on, instrument
         FROM finance_transaction WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_on ASC, created_at ASC, id ASC LIMIT ${MAX_EXPORT_ROWS + 1}`,
      values,
    );
    if (result.rows.length > MAX_EXPORT_ROWS)
      throw new ExportFailure("A exportação excede o limite de 50.000 linhas.");
    return result.rows.map(transactionRow);
  }

  private async countTransactions(
    client: PoolClient,
    input: Parameters<ExportSource["read"]>[0],
  ): Promise<number> {
    const values: unknown[] = [input.workspaceId];
    const conditions = ["workspace_id = $1"];
    addTransactionFilters(input.request, conditions, values);
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM finance_transaction WHERE ${conditions.join(" AND ")}`,
      values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async readProducts(
    client: PoolClient,
    workspaceId: string,
  ): Promise<readonly CsvExportRow[]> {
    const result = await client.query<ProductRow>(
      `SELECT id, name, quantity_milli, unit, minimum_milli, category, location, archived, marked_missing
         FROM stock_product WHERE workspace_id = $1 ORDER BY lower(name) ASC, id ASC LIMIT ${MAX_EXPORT_ROWS + 1}`,
      [workspaceId],
    );
    if (result.rows.length > MAX_EXPORT_ROWS)
      throw new ExportFailure("A exportação excede o limite de 50.000 linhas.");
    return result.rows.map(productRow);
  }

  private async countProducts(client: PoolClient, workspaceId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stock_product WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

const transactionColumns: readonly CsvExportColumn[] = [
  { key: "type", label: "Tipo" },
  { key: "amount", label: "Valor" },
  { key: "date", label: "Data" },
  { key: "state", label: "Estado" },
  { key: "description", label: "Descrição" },
  { key: "category", label: "Categoria" },
  { key: "due_on", label: "Vencimento" },
  { key: "payment_method", label: "Meio" },
];
const productColumns: readonly CsvExportColumn[] = [
  { key: "name", label: "Nome" },
  { key: "quantity", label: "Quantidade" },
  { key: "unit", label: "Unidade" },
  { key: "minimum", label: "Mínimo" },
  { key: "category", label: "Categoria" },
  { key: "location", label: "Local" },
  { key: "status", label: "Status" },
];

interface TransactionRow {
  id: string;
  kind: string;
  amount_minor: bigint | string;
  occurred_on: string;
  state: string;
  description: string;
  category_id: string | null;
  due_on: string | null;
  instrument: string;
}
interface ProductRow {
  id: string;
  name: string;
  quantity_milli: bigint | string | null;
  unit: string;
  minimum_milli: bigint | string | null;
  category: string | null;
  location: string | null;
  archived: boolean;
  marked_missing: boolean;
}

function transactionRow(row: TransactionRow): CsvExportRow {
  return {
    casei_id: row.id,
    type: row.kind,
    amount: formatMinorAmount(row.amount_minor),
    date: row.occurred_on,
    state: row.state,
    description: row.description,
    category: row.category_id,
    due_on: row.due_on,
    payment_method: row.instrument,
  };
}
function productRow(row: ProductRow): CsvExportRow {
  return {
    casei_id: row.id,
    name: row.name,
    quantity: formatMilli(row.quantity_milli),
    unit: row.unit,
    minimum: formatMilli(row.minimum_milli),
    category: row.category,
    location: row.location,
    status: row.archived ? "archived" : row.marked_missing ? "missing" : "ok",
  };
}
function formatMinorAmount(value: bigint | string): string {
  const minor = BigInt(value);
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  const text = absolute.toString().padStart(3, "0");
  return `${sign}${text.slice(0, -2)},${text.slice(-2)}`;
}
function formatMilli(value: bigint | string | null): string | null {
  if (value === null) return null;
  const milli = BigInt(value);
  const sign = milli < 0n ? "-" : "";
  const absolute = milli < 0n ? -milli : milli;
  const text = absolute.toString().padStart(4, "0");
  return `${sign}${text.slice(0, -3)},${text.slice(-3)}`.replace(/,?0+$/u, (match) =>
    match === ",000" ? "" : match,
  );
}

function addTransactionFilters(
  request: ExportCreateRequest,
  conditions: string[],
  values: unknown[],
): void {
  if (request.from) {
    values.push(request.from);
    conditions.push(`occurred_on >= $${values.length}::date`);
  }
  if (request.to) {
    values.push(request.to);
    conditions.push(`occurred_on <= $${values.length}::date`);
  }
  if (request.kind && request.kind !== "all") {
    values.push(request.kind);
    conditions.push(`kind = $${values.length}`);
  }
  if (request.categoryId) {
    values.push(request.categoryId);
    conditions.push(`category_id = $${values.length}::uuid`);
  }
}

function mapExportJob(row: ExportJobRow): ExportJobRecord {
  const parsed = exportCreateRequestSchema.safeParse(row.request);
  if (!parsed.success) {
    throw new ExportFailure("O job de exportação possui uma solicitação inválida.");
  }
  const request = parsed.data;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    requiredCapability: "export",
    request,
    fileName: row.file_name,
    storageKey: row.storage_key,
    outputSha256: row.output_sha256,
    outputBytes: row.output_bytes,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    progress: row.progress,
    state: row.state,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    lastError: row.last_error,
    version: row.version,
    correlationId: row.correlation_id,
  };
}
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function assertRequestMatches(first: ExportCreateRequest, second: ExportCreateRequest): void {
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new ExportConflictError("A chave de idempotência já foi usada com outra exportação.");
}
function safeExportFailureMessage(error: unknown): string {
  if (error instanceof ExportFailure || error instanceof ExportConflictError)
    return error.message.slice(0, 1_000);
  return "A exportação falhou; tente novamente.";
}
function exportPayload(value: unknown): { exportJobId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("exportJobId" in value) ||
    typeof value.exportJobId !== "string"
  ) {
    throw new ExportFailure("O payload do job de exportação é inválido.");
  }
  return { exportJobId: value.exportJobId };
}

export function createExportWorker(input: {
  readonly pool: Pool;
  readonly source: ExportSource;
  readonly storage: ObjectStoragePort;
  readonly environment: StorageEnvironment;
  readonly applicationRole?: string;
}): PostgresJobWorker {
  const store = new PostgresExportJobStore(input.pool, input.applicationRole);
  const application = new ExportApplication(store, input.source, input.storage, {
    environment: input.environment,
  });
  return new PostgresJobWorker(
    input.pool,
    new Map([
      [
        "data.export:1",
        async (job, execution) => {
          if (!job.workspaceId) throw new JobAuthorizationError();
          const payload = exportPayload(job.payload);
          await application.run(payload.exportJobId, job.workspaceId, execution);
        },
      ],
    ]),
    {
      applicationRole: input.applicationRole,
      authorizeCapability: ({ capability }) => capability === "export",
      onAuthorizationRevoked: async (job) => application.expireRevoked(job),
    },
  );
}

export async function runExportWorkerOnce(
  input: {
    readonly pool: Pool;
    readonly source: ExportSource;
    readonly storage: ObjectStoragePort;
    readonly environment: StorageEnvironment;
    readonly applicationRole?: string;
  },
  at = new Date(),
): Promise<number> {
  const role = input.applicationRole ?? "casei_app";
  const worker = createExportWorker({ ...input, applicationRole: role });
  const workspaces = await withUnitOfWork(
    input.pool,
    { applicationRole: role },
    ({ client }) =>
      client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM app.list_data_export_workspaces($1::timestamptz)`,
        [at],
      ),
    { readOnly: true },
  );
  let processed = 0;
  for (const row of workspaces.rows) {
    const result = await worker.runOnce(row.workspace_id, at);
    if (result.state !== "idle") processed += 1;
  }
  return processed;
}
