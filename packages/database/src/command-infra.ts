import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60 * 1_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CommandScope {
  workspaceId?: string;
  actorId?: string;
  actorEmail?: string;
  correlationId?: string;
  applicationRole?: string;
}

export interface UnitOfWorkContext {
  client: PoolClient;
  scope: CommandScope;
}

export interface UnitOfWorkOptions {
  isolationLevel?: "repeatable read" | "serializable";
  readOnly?: boolean;
}

/** Runs a command in one database transaction and applies the RLS context locally. */
export async function withUnitOfWork<T>(
  pool: Pool,
  scope: CommandScope,
  callback: (context: UnitOfWorkContext) => Promise<T>,
  options: UnitOfWorkOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (options.isolationLevel || options.readOnly) {
      const characteristics = [
        options.isolationLevel ? `ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}` : null,
        options.readOnly ? "READ ONLY" : null,
      ].filter((value): value is string => value !== null);
      await client.query(`SET TRANSACTION ${characteristics.join(", ")}`);
    }
    if (scope.applicationRole) {
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(scope.applicationRole)}`);
    }
    await setLocalContext(client, scope);

    const result = await callback({ client, scope });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original command failure when rollback itself cannot complete.
    }
    throw error;
  } finally {
    client.release();
  }
}

export const runInTransaction = withUnitOfWork;

async function setLocalContext(client: PoolClient, scope: CommandScope): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.workspace_id', $1, true),
       set_config('app.actor_id', $2, true),
       set_config('app.actor_email', $3, true),
       set_config('app.correlation_id', $4, true)`,
    [
      scope.workspaceId ?? "",
      scope.actorId ?? "",
      scope.actorEmail ?? "",
      scope.correlationId ?? "",
    ],
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Invalid PostgreSQL role identifier");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Request contains a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) {
      throw new TypeError("Request contains an invalid date");
    }
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) {
        result[key] = toCanonicalValue(child);
      }
    }
    return result;
  }
  throw new TypeError("Request contains an unsupported value");
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function validateIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7e]{16,128}$/.test(key)) {
    throw new TypeError("Idempotency-Key must contain 16 to 128 printable ASCII characters");
  }
}

export function idempotencyScope(input: {
  actorId: string;
  workspaceId?: string;
  method: string;
  route: string;
}): string {
  return [
    input.actorId,
    input.workspaceId ?? "global",
    input.method.toUpperCase(),
    input.route,
  ].join(":");
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict" as const;

  constructor() {
    super("The idempotency key was already used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends Error {
  readonly code = "idempotency_in_progress" as const;

  constructor() {
    super("The idempotent request is still being processed");
    this.name = "IdempotencyInProgressError";
  }
}

export interface IdempotencyCommand<T extends JsonValue> {
  scope: string;
  key: string;
  request: unknown;
  expiresAt?: Date;
  now?: Date;
  execute: () => Promise<{ statusCode: number; response: T }>;
}

export interface IdempotencyResult<T extends JsonValue> {
  replayed: boolean;
  statusCode: number;
  response: T;
}

/** Deduplicates a command inside the caller's transaction. */
export async function executeIdempotent<T extends JsonValue>(
  client: PoolClient,
  command: IdempotencyCommand<T>,
): Promise<IdempotencyResult<T>> {
  validateIdempotencyKey(command.key);
  const now = command.now ?? new Date();
  const expiresAt = command.expiresAt ?? new Date(now.valueOf() + DEFAULT_IDEMPOTENCY_TTL_MS);
  const requestHash = hashRequest(command.request);

  // Expired entries no longer reserve a key. The delete is serialized with the unique index.
  await client.query(
    `DELETE FROM "idempotency_key"
     WHERE scope = $1 AND key = $2 AND expires_at <= $3`,
    [command.scope, command.key, now],
  );

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO "idempotency_key" (scope, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, key) DO NOTHING
     RETURNING id`,
    [command.scope, command.key, requestHash, expiresAt],
  );

  if (inserted.rowCount === 0) {
    const existing = await client.query<{
      request_hash: string;
      status_code: number | null;
      response: T | null;
    }>(
      `SELECT request_hash, status_code, response
       FROM "idempotency_key"
       WHERE scope = $1 AND key = $2`,
      [command.scope, command.key],
    );
    const row = existing.rows[0];
    if (!row) {
      // This can only happen if an expired row was deleted concurrently; retrying is safe.
      return executeIdempotent(client, command);
    }
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    if (row.status_code === null) {
      throw new IdempotencyInProgressError();
    }
    return { replayed: true, statusCode: row.status_code, response: row.response as T };
  }

  const result = await command.execute();
  if (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) {
    throw new RangeError("Idempotency response status must be an HTTP status code");
  }
  await client.query(
    `UPDATE "idempotency_key"
     SET status_code = $3, response = $4
     WHERE scope = $1 AND key = $2`,
    [command.scope, command.key, result.statusCode, result.response],
  );
  return { replayed: false, ...result };
}

export interface OutboxEventInput {
  id?: string;
  eventType: string;
  eventVersion: number;
  workspaceId?: string;
  actorId?: string;
  requiredCapability?: string;
  correlationId: string;
  payload: JsonValue;
  availableAt?: Date;
}

export async function enqueueOutboxEvent(
  client: PoolClient,
  event: OutboxEventInput,
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO "outbox_event"
      (id, event_type, event_version, workspace_id, actor_id, required_capability,
       correlation_id, payload, available_at)
     VALUES (COALESCE($1::uuid, uuidv7()), $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9, now()))
     RETURNING id`,
    [
      event.id ?? null,
      event.eventType,
      event.eventVersion,
      event.workspaceId ?? null,
      event.actorId ?? null,
      event.requiredCapability ?? null,
      event.correlationId,
      JSON.stringify(event.payload),
      event.availableAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Outbox insert did not return an ID");
  return row;
}

export interface DispatchOutboxOptions extends CommandScope {
  limit?: number;
  now?: Date;
  priority?: number;
}

export async function dispatchOutbox(
  pool: Pool,
  options: DispatchOutboxOptions,
): Promise<{ published: number }> {
  if (!options.workspaceId) {
    throw new TypeError("Outbox dispatch requires a workspace scope");
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const now = options.now ?? new Date();
  return withUnitOfWork(pool, options, async ({ client }) => {
    const events = await client.query<OutboxRow>(
      `SELECT id, event_type, event_version, workspace_id, actor_id, required_capability,
              correlation_id, payload, available_at
       FROM "outbox_event"
       WHERE status = 'pending' AND available_at <= $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    let published = 0;
    for (const event of events.rows) {
      await client.query(
        `INSERT INTO "job"
          (job_type, job_version, workspace_id, actor_id, required_capability,
           idempotency_key, payload, priority, available_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (job_type, idempotency_key) DO NOTHING`,
        [
          event.event_type,
          event.event_version,
          event.workspace_id,
          event.actor_id,
          event.required_capability,
          `outbox:${event.id}`,
          JSON.stringify(event.payload),
          options.priority ?? 0,
          event.available_at,
          event.correlation_id,
        ],
      );
      await client.query(
        `UPDATE "outbox_event"
         SET status = 'published', published_at = $2, attempts = attempts + 1
         WHERE id = $1 AND status = 'pending'`,
        [event.id, now],
      );
      published += 1;
    }
    return { published };
  });
}

interface OutboxRow extends QueryResultRow {
  id: string;
  event_type: string;
  event_version: number;
  workspace_id: string | null;
  actor_id: string | null;
  required_capability: string | null;
  correlation_id: string;
  payload: JsonValue;
  available_at: Date;
}

export interface JobRecord {
  id: string;
  jobType: string;
  jobVersion: number;
  workspaceId: string | null;
  actorId: string | null;
  requiredCapability: string | null;
  idempotencyKey: string;
  payload: JsonValue;
  state: string;
  priority: number;
  attempts: number;
  availableAt: Date;
  leaseUntil: Date | null;
  leaseToken: string;
  correlationId: string;
  lastError: string | null;
}

export class JobAuthorizationError extends Error {
  readonly code = "job_authorization_revoked" as const;

  constructor() {
    super("Job authorization is no longer valid");
    this.name = "JobAuthorizationError";
  }
}

export class JobLeaseLostError extends Error {
  readonly code = "job_lease_lost" as const;

  constructor() {
    super("Job lease is no longer valid");
    this.name = "JobLeaseLostError";
  }
}

export type CapabilityAuthorizer = (input: {
  role: string;
  capability: string | null;
  actorId: string;
  workspaceId: string;
}) => boolean | Promise<boolean>;

export interface JobBatchContext {
  client: PoolClient;
  beforeTransition: () => Promise<void>;
}

export interface JobExecutionContext {
  runBatch<T>(callback: (context: JobBatchContext) => Promise<T>): Promise<T>;
  renewLease(): Promise<boolean>;
}

export type JobHandler = (job: JobRecord, context: JobExecutionContext) => Promise<void>;

export interface JobWorkerOptions extends CommandScope {
  leaseMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  authorizeCapability?: CapabilityAuthorizer;
  /** Optional cleanup hook for jobs whose domain state must be fenced on revocation. */
  onAuthorizationRevoked?: (job: JobRecord) => Promise<void>;
}

export type JobRunResult =
  | { state: "idle" }
  | { state: "succeeded"; jobId: string }
  | { state: "failed" | "dead" | "cancelled" | "lease_lost"; jobId: string };

export class PostgresJobWorker {
  private readonly options: Required<
    Pick<JobWorkerOptions, "leaseMs" | "maxAttempts" | "backoffBaseMs" | "backoffMaxMs" | "random">
  > &
    JobWorkerOptions;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    options: JobWorkerOptions = {},
  ) {
    this.options = {
      ...options,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      random: options.random ?? Math.random,
    };
  }

  async runOnce(workspaceId: string, now = new Date()): Promise<JobRunResult> {
    const job = await this.claim(workspaceId, now);
    if (!job) return { state: "idle" };

    const handler = this.handlers.get(handlerKey(job.jobType, job.jobVersion));
    if (!handler) {
      await this.markFailed(job, new Error("Unsupported job handler"), true);
      return { state: "dead", jobId: job.id };
    }

    try {
      await this.assertAuthorized(job);
      const context: JobExecutionContext = {
        runBatch: (callback) => this.runBatch(job, callback),
        renewLease: () => this.renewLease(job),
      };
      await handler(job, context);
      const completed = await this.markSucceeded(job);
      return completed
        ? { state: "succeeded", jobId: job.id }
        : { state: "cancelled", jobId: job.id };
    } catch (error) {
      if (error instanceof JobLeaseLostError) {
        return { state: "lease_lost", jobId: job.id };
      }
      if (error instanceof JobAuthorizationError) {
        await this.options.onAuthorizationRevoked?.(job);
        await this.markCancelled(job);
        return { state: "cancelled", jobId: job.id };
      }
      const dead = await this.markFailed(job, error, false);
      return { state: dead ? "dead" : "failed", jobId: job.id };
    }
  }

  private async claim(workspaceId: string, now: Date): Promise<JobRecord | null> {
    const leaseToken = randomUUID();
    return withUnitOfWork(
      this.pool,
      { workspaceId, applicationRole: this.options.applicationRole },
      async ({ client }) => {
        const result = await client.query<JobRow>(
          `WITH candidate AS (
             SELECT id
             FROM "job"
             WHERE workspace_id = $1
               AND (
                 (state IN ('pending', 'failed') AND available_at <= $2)
                 OR (state = 'running' AND lease_until <= clock_timestamp())
               )
             ORDER BY priority DESC, available_at ASC, id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE "job" AS j
           SET state = 'running', attempts = j.attempts + 1,
               lease_until = clock_timestamp() + ($3 * interval '1 millisecond'),
               lease_token = $4, updated_at = clock_timestamp()
           FROM candidate
           WHERE j.id = candidate.id
           RETURNING j.*`,
          [workspaceId, now, this.options.leaseMs, leaseToken],
        );
        const row = result.rows[0];
        return row ? mapJob(row) : null;
      },
    );
  }

  private async assertAuthorized(job: JobRecord): Promise<void> {
    if (!job.workspaceId || !job.actorId) {
      if (!isSystemJob(job)) throw new JobAuthorizationError();
      return;
    }
    await withUnitOfWork(
      this.pool,
      {
        workspaceId: job.workspaceId,
        actorId: job.actorId,
        applicationRole: this.options.applicationRole,
      },
      async ({ client }) => {
        await assertLeaseFenced(client, job);
        await assertMembership(
          client,
          job,
          this.options.authorizeCapability ?? defaultCapabilityAuthorizer,
        );
      },
    );
  }

  private async runBatch<T>(
    job: JobRecord,
    callback: (context: JobBatchContext) => Promise<T>,
  ): Promise<T> {
    if (!job.workspaceId) throw new JobAuthorizationError();
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: job.workspaceId,
        actorId: job.actorId ?? undefined,
        applicationRole: this.options.applicationRole,
      },
      async ({ client }) => {
        await assertLeaseFenced(client, job);
        if (!isSystemJob(job)) {
          await assertMembership(
            client,
            job,
            this.options.authorizeCapability ?? defaultCapabilityAuthorizer,
          );
        }
        const result = await callback({
          client,
          beforeTransition: async () => {
            await assertLeaseFenced(client, job);
            if (!isSystemJob(job)) {
              await assertMembership(
                client,
                job,
                this.options.authorizeCapability ?? defaultCapabilityAuthorizer,
              );
            }
          },
        });
        await assertLeaseFenced(client, job);
        return result;
      },
    );
  }

  private async renewLease(job: JobRecord): Promise<boolean> {
    if (!job.workspaceId) return false;
    return withUnitOfWork(
      this.pool,
      { workspaceId: job.workspaceId, applicationRole: this.options.applicationRole },
      async ({ client }) => {
        const result = await client.query(
          `UPDATE "job"
           SET lease_until = clock_timestamp() + ($4 * interval '1 millisecond'), updated_at = clock_timestamp()
           WHERE id = $1 AND state = 'running' AND lease_token = $2
             AND workspace_id = $3 AND lease_until > clock_timestamp()`,
          [job.id, job.leaseToken, job.workspaceId, this.options.leaseMs],
        );
        return result.rowCount === 1;
      },
    );
  }

  private async markSucceeded(job: JobRecord): Promise<boolean> {
    if (!job.workspaceId) return false;
    const systemJob = isSystemJob(job);
    return withUnitOfWork(
      this.pool,
      systemJob
        ? { applicationRole: this.options.applicationRole }
        : {
            workspaceId: job.workspaceId,
            actorId: job.actorId ?? undefined,
            applicationRole: this.options.applicationRole,
          },
      async ({ client }) => {
        await assertLeaseFenced(client, job);
        if (!systemJob) {
          try {
            await assertMembership(
              client,
              job,
              this.options.authorizeCapability ?? defaultCapabilityAuthorizer,
            );
          } catch (error) {
            if (error instanceof JobAuthorizationError) {
              await client.query(
                `UPDATE "job"
                 SET state = 'cancelled', lease_until = NULL, lease_token = NULL,
                     last_error = $3, updated_at = now()
                 WHERE id = $1 AND state = 'running' AND lease_token = $2 AND lease_until > clock_timestamp()`,
                [job.id, job.leaseToken, "job_authorization_revoked"],
              );
              return false;
            }
            throw error;
          }
        }
        const result = await client.query(
          `UPDATE "job"
           SET state = 'succeeded', lease_until = NULL, lease_token = NULL, updated_at = now()
           WHERE id = $1 AND state = 'running' AND lease_token = $2 AND lease_until > clock_timestamp()`,
          [job.id, job.leaseToken],
        );
        return result.rowCount === 1;
      },
    );
  }

  private async markCancelled(job: JobRecord): Promise<void> {
    if (!job.workspaceId) return;
    await withUnitOfWork(
      this.pool,
      { workspaceId: job.workspaceId, applicationRole: this.options.applicationRole },
      async ({ client }) => {
        await client.query(
          `UPDATE "job"
           SET state = 'cancelled', lease_until = NULL, lease_token = NULL,
               last_error = $3, updated_at = now()
           WHERE id = $1 AND state = 'running' AND lease_token = $2 AND lease_until > clock_timestamp()`,
          [job.id, job.leaseToken, "job_authorization_revoked"],
        );
      },
    );
  }

  private async markFailed(job: JobRecord, error: unknown, forceDead: boolean): Promise<boolean> {
    if (!job.workspaceId) return true;
    const dead = forceDead || job.attempts >= this.options.maxAttempts;
    const delay = dead ? 0 : backoffDelay(job.attempts, this.options, this.options.random());
    const nextState = dead ? "dead" : "failed";
    await withUnitOfWork(
      this.pool,
      { workspaceId: job.workspaceId, applicationRole: this.options.applicationRole },
      async ({ client }) => {
        await client.query(
          `UPDATE "job"
           SET state = $3,
               available_at = clock_timestamp() + ($4 * interval '1 millisecond'),
               lease_until = NULL, lease_token = NULL,
               last_error = $5, updated_at = clock_timestamp()
           WHERE id = $1 AND state = 'running' AND lease_token = $2 AND lease_until > clock_timestamp()`,
          [job.id, job.leaseToken, nextState, delay, sanitizeError(error)],
        );
      },
    );
    return dead;
  }
}

interface JobRow extends QueryResultRow {
  id: string;
  job_type: string;
  job_version: number;
  workspace_id: string | null;
  actor_id: string | null;
  required_capability: string | null;
  idempotency_key: string;
  payload: JsonValue;
  state: string;
  priority: number;
  attempts: number;
  available_at: Date;
  lease_until: Date | null;
  lease_token: string | null;
  correlation_id: string;
  last_error: string | null;
}

function mapJob(row: JobRow): JobRecord {
  if (!row.lease_token) throw new Error("Claimed job has no lease token");
  return {
    id: row.id,
    jobType: row.job_type,
    jobVersion: row.job_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    requiredCapability: row.required_capability,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    state: row.state,
    priority: row.priority,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseUntil: row.lease_until,
    leaseToken: row.lease_token,
    correlationId: row.correlation_id,
    lastError: row.last_error,
  };
}

function handlerKey(jobType: string, version: number): string {
  return `${jobType}:${version}`;
}

const defaultCapabilityAuthorizer: CapabilityAuthorizer = ({ role }) => role === "owner";

function isSystemJob(job: JobRecord): boolean {
  return (
    (job.jobType === "workspace.purge" &&
      job.jobVersion === 1 &&
      job.requiredCapability === "system.purge" &&
      job.actorId === null) ||
    (job.jobType === "recurrence.expand" &&
      job.jobVersion === 1 &&
      job.requiredCapability === "system.recurrence" &&
      job.actorId === null)
  );
}

async function assertLeaseFenced(client: PoolClient, job: JobRecord): Promise<void> {
  const result = await client.query<{
    state: string;
    lease_token: string | null;
    lease_until: Date | null;
    lease_valid: boolean;
  }>(
    `SELECT state, lease_token, lease_until, lease_until > clock_timestamp() AS lease_valid
     FROM "job"
     WHERE id = $1
     FOR UPDATE`,
    [job.id],
  );
  const current = result.rows[0];
  if (
    current?.state !== "running" ||
    current.lease_token !== job.leaseToken ||
    !current.lease_until ||
    !current.lease_valid
  ) {
    throw new JobLeaseLostError();
  }
}

async function assertMembership(
  client: PoolClient,
  job: JobRecord,
  authorizeCapability?: CapabilityAuthorizer,
): Promise<void> {
  if (!job.actorId && !job.requiredCapability) return;
  if (!job.workspaceId || !job.actorId) throw new JobAuthorizationError();
  const result = await client.query<{ role: string; status: string }>(
    `SELECT role, status
     FROM "membership"
     WHERE workspace_id = $1 AND user_id = $2
     FOR UPDATE`,
    [job.workspaceId, job.actorId],
  );
  const membership = result.rows[0];
  if (membership?.status !== "active") throw new JobAuthorizationError();
  if (
    job.requiredCapability &&
    authorizeCapability &&
    !(await authorizeCapability({
      role: membership.role,
      capability: job.requiredCapability,
      actorId: job.actorId,
      workspaceId: job.workspaceId,
    }))
  ) {
    throw new JobAuthorizationError();
  }
}

function backoffDelay(
  attempts: number,
  options: Pick<JobWorkerOptions, "backoffBaseMs" | "backoffMaxMs">,
  random: number,
): number {
  const exponential = Math.min(
    options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    (options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS) * 2 ** Math.max(0, attempts - 1),
  );
  return Math.round(exponential * (0.5 + Math.min(1, Math.max(0, random)) * 0.5));
}

function sanitizeError(error: unknown): string {
  if (error instanceof JobAuthorizationError) return "job_authorization_revoked";
  if (
    error instanceof Error &&
    error.name === "Error" &&
    error.message === "Unsupported job handler"
  ) {
    return "unsupported_job_handler";
  }
  return "job_handler_failed";
}
