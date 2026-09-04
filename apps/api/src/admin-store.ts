import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type {
  AdminAccountDetail,
  AdminAccountList,
  AdminAccountSearchQuery,
  AdminAccountSummary,
  AdminAuditList,
  AdminAuditSearchQuery,
  AdminJobList,
  AdminJobSearchQuery,
  AdminJobSummary,
  PlatformRole,
} from "@casei/contracts";
import type { Pool, PoolClient } from "@casei/database";
import { canonicalJson } from "@casei/database";
import { PlatformBootstrapAlreadyCompletedError } from "./admin-bootstrap.js";
import { AdminPolicyError } from "./admin-policy.js";
import type { AdminRateLimiter } from "./admin-routes.js";
import {
  type AdminAccountStore,
  type AdminEmailCommand,
  type AdminEmailDeliveryAudit,
  AdminNotFoundError,
} from "./admin-service.js";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./http/cursor.js";

type QueryResultRow = Record<string, unknown>;
type AccountRow = QueryResultRow & {
  user_id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  created_at: Date;
  last_activity_at: Date | null;
  workspace_count: string;
  active_session_count: string;
};
type WorkspaceRow = QueryResultRow & { id: string; name: string; status: string };
type SessionRow = QueryResultRow & {
  id: string;
  created_at: Date;
  updated_at: Date | null;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
};

type JobRow = QueryResultRow & {
  id: string;
  job_type: string;
  job_version: number;
  workspace_id: string | null;
  actor_id: string | null;
  required_capability: string | null;
  state: string;
  attempts: number;
  available_at: Date;
  lease_until: Date | null;
  correlation_id: string;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type AuditRow = QueryResultRow & {
  id: string;
  actor_id: string | null;
  target_id: string | null;
  action: string;
  occurred_at: Date;
  origin: string;
  correlation_id: string;
  ip_address: string | null;
  endpoint: string | null;
  result: string;
  reason: string;
};

const ADMIN_CURSOR_SECRET = process.env.CASEI_ADMIN_CURSOR_SECRET ?? "casei-admin-cursor-mvp-2026";
const JOB_CURSOR_ORDERING = "admin-jobs:created_at,id:desc";
const AUDIT_CURSOR_ORDERING = "admin-audit:occurred_at,id:desc";

export class AdminIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict" as const;

  constructor() {
    super("The idempotency key was already used with different content");
    this.name = "AdminIdempotencyConflictError";
  }
}

export class AdminJobNotReadyError extends Error {
  readonly code = "job_not_ready" as const;

  constructor() {
    super("This job cannot be retried");
    this.name = "AdminJobNotReadyError";
  }
}

/**
 * Narrow PostgreSQL adapter for the platform boundary. `platform_account` and
 * `platform_audit_event` are intentionally introduced by the coordinated
 * post-DATA/CARD migration; this adapter never trusts a client-provided role.
 */
export class PostgresAdminAccountStore implements AdminAccountStore {
  private readonly transaction = new AsyncLocalStorage<PoolClient>();

  constructor(
    private readonly pool: Pool,
    private readonly applicationRole = "casei_app",
  ) {}

  async searchAccounts(input: AdminAccountSearchQuery): Promise<AdminAccountList> {
    const query = input.query.toLowerCase();
    const rows = await this.query<AccountRow>(
      `SELECT u.id AS user_id,
              u.name,
              u.email,
              p.role,
              p.status,
              u.created_at,
              md.last_activity_at,
              md.workspace_count::text AS workspace_count,
              md.active_session_count::text AS active_session_count
         FROM "user" u
         LEFT JOIN platform_account p ON p.user_id = u.id
         LEFT JOIN LATERAL app.platform_account_metadata(u.id) md ON true
        WHERE (u.id = $1 OR lower(u.email) = $1)
          AND ($2::text IS NULL OR u.id > $2)
        ORDER BY u.id
        LIMIT $3`,
      [query, input.cursor ?? null, Math.min(input.limit, 100) + 1],
    );
    const hasMore = rows.rows.length > input.limit;
    const visibleRows = rows.rows.slice(0, input.limit);
    return {
      items: visibleRows.map(toAccountSummary),
      page: {
        nextCursor: hasMore ? (visibleRows.at(-1)?.user_id ?? null) : null,
        hasMore,
      },
    };
  }

  async getAccount(userId: string): Promise<AdminAccountDetail | null> {
    return this.fetchAccount(userId);
  }

  async withActor<T>(actorId: string, run: () => Promise<T>): Promise<T> {
    const existing = this.transaction.getStore();
    if (existing) {
      await this.configureClient(existing, actorId);
      return run();
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.configureClient(client, actorId);
      const result = await this.transaction.run(client, run);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolvePlatformActor(userId: string): Promise<{
    role: PlatformRole | null;
    suspended: boolean;
  }> {
    return this.withActor(userId, async () => {
      const result = await this.query<{ role: string | null; status: string | null }>(
        `SELECT role, status FROM platform_account WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      return {
        role: row?.role === "platform_admin" || row?.role === "platform_support" ? row.role : null,
        suspended: row?.status === "suspended",
      };
    });
  }

  async claimFirstPlatformAdmin(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.configureClient(client, userId);
      await client.query(`SELECT app.claim_first_platform_admin($1)`, [userId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "55000") {
        throw new PlatformBootstrapAlreadyCompletedError();
      }
      if ((error as { code?: string }).code === "P0002") throw new AdminNotFoundError();
      throw error;
    } finally {
      client.release();
    }
  }

  async countActivePlatformAdmins(): Promise<number> {
    const result = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM platform_account
        WHERE role = 'platform_admin' AND status = 'active'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateStatus(
    userId: string,
    status: "active" | "suspended",
    reason = "",
  ): Promise<AdminAccountDetail> {
    await this.query(`SELECT app.lock_platform_session_user($1)`, [userId]);
    if (status === "suspended") await this.lockAndProtectLastAdmin(userId);
    await this.query(
      `INSERT INTO platform_account (user_id, role, status, suspension_reason, version)
       SELECT $1, p.role, $2, CASE WHEN $2 = 'suspended' THEN $3 ELSE NULL END, 1
         FROM "user" u
         LEFT JOIN platform_account p ON p.user_id = u.id
        WHERE u.id = $1
       ON CONFLICT (user_id) DO UPDATE
         SET status = EXCLUDED.status,
             suspension_reason = EXCLUDED.suspension_reason,
             version = platform_account.version + 1,
             updated_at = now()`,
      [userId, status, reason],
    );
    if (status === "suspended")
      await this.query(`DELETE FROM session WHERE user_id = $1`, [userId]);
    const account = await this.fetchAccount(userId);
    if (!account) throw new AdminNotFoundError();
    return account;
  }

  async updateRole(
    userId: string,
    role: PlatformRole | null,
    reason = "",
  ): Promise<AdminAccountDetail> {
    if (role !== "platform_admin") await this.lockAndProtectLastAdmin(userId);
    await this.query(
      `INSERT INTO platform_account (user_id, role, status, role_change_reason, version)
       SELECT $1, $2, COALESCE(p.status, 'active'), $3, 1
         FROM "user" u
         LEFT JOIN platform_account p ON p.user_id = u.id
        WHERE u.id = $1
       ON CONFLICT (user_id) DO UPDATE
         SET role = EXCLUDED.role,
             role_change_reason = EXCLUDED.role_change_reason,
             version = platform_account.version + 1,
             updated_at = now()`,
      [userId, role, reason],
    );
    const account = await this.fetchAccount(userId);
    if (!account) throw new AdminNotFoundError();
    return account;
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.query(`DELETE FROM session WHERE id = $1 AND user_id = $2`, [
      sessionId,
      userId,
    ]);
    if (result.rowCount !== 1) throw new AdminNotFoundError();
  }

  async searchJobs(input: AdminJobSearchQuery): Promise<AdminJobList> {
    const cursor = decodePosition(input.cursor, JOB_CURSOR_ORDERING);
    const rows = await this.query<JobRow>(
      `SELECT id, job_type, job_version, workspace_id, actor_id, required_capability,
              state, attempts, available_at, lease_until, correlation_id, last_error,
              created_at, updated_at
         FROM job
        WHERE job_type IN ('data.import', 'recurrence.expand')
          AND ($1::text IS NULL OR job_type = $1)
          AND ($2::text IS NULL OR state = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [
        input.type ?? null,
        input.state ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        input.limit + 1,
      ],
    );
    const healthResult = await this.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
         FROM job
        WHERE job_type IN ('data.import', 'recurrence.expand')
          AND ($1::text IS NULL OR job_type = $1)
          AND ($2::text IS NULL OR state = $2)
        GROUP BY state`,
      [input.type ?? null, input.state ?? null],
    );
    const health = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
      cancelled: 0,
    };
    for (const row of healthResult.rows) {
      if (row.state in health) health[row.state as keyof typeof health] = Number(row.count);
    }
    const hasMore = rows.rows.length > input.limit;
    const items = rows.rows.slice(0, input.limit).map(toAdminJobSummary);
    const last = items.at(-1);
    return {
      items,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor(
                { ordering: JOB_CURSOR_ORDERING, position: [last.createdAt, last.id] },
                ADMIN_CURSOR_SECRET,
              )
            : null,
      },
      health,
    };
  }

  async retryJob(jobId: string): Promise<AdminJobSummary> {
    const result = await this.query<JobRow>(
      `UPDATE job
          SET state = 'pending', lease_until = NULL, lease_token = NULL,
              available_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1
          AND job_type IN ('data.import', 'recurrence.expand')
          AND state IN ('failed', 'dead')
      RETURNING id, job_type, job_version, workspace_id, actor_id, required_capability,
                state, attempts, available_at, lease_until, correlation_id, last_error,
                created_at, updated_at`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) throw new AdminJobNotReadyError();
    return toAdminJobSummary(row);
  }

  async searchAudit(input: AdminAuditSearchQuery): Promise<AdminAuditList> {
    const cursor = decodePosition(input.cursor, AUDIT_CURSOR_ORDERING);
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1_000);
    const from = input.from ? new Date(input.from) : cutoff;
    const lowerBound = from > cutoff ? from : cutoff;
    const to = input.to ? new Date(input.to) : null;
    const rows = await this.query<AuditRow>(
      `SELECT id, actor_id, target_id, action, occurred_at, origin, correlation_id,
              ip_address, endpoint, result, reason
         FROM platform_audit_event
        WHERE occurred_at >= $1
          AND ($2::timestamptz IS NULL OR occurred_at <= $2)
          AND ($3::text IS NULL OR actor_id = $3)
          AND ($4::text IS NULL OR target_id = $4)
          AND ($5::text IS NULL OR action = $5)
          AND ($6::timestamptz IS NULL OR (occurred_at, id) < ($6, $7::uuid))
        ORDER BY occurred_at DESC, id DESC
        LIMIT $8`,
      [
        lowerBound,
        to,
        input.actorId ?? null,
        input.targetId ?? null,
        input.action ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        input.limit + 1,
      ],
    );
    const hasMore = rows.rows.length > input.limit;
    const items = rows.rows.slice(0, input.limit).map(toAdminAuditEvent);
    const last = items.at(-1);
    return {
      items,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor(
                { ordering: AUDIT_CURSOR_ORDERING, position: [last.occurredAt, last.id] },
                ADMIN_CURSOR_SECRET,
              )
            : null,
      },
    };
  }

  async recordAudit(input: {
    actorId: string;
    targetId: string;
    action: string;
    reason: string;
    correlationId: string;
    ipAddress?: string | null;
    endpoint?: string | null;
    result?: "success" | "failure";
  }): Promise<void> {
    await this.query(
      `INSERT INTO platform_audit_event
        (actor_id, target_id, action, occurred_at, origin, correlation_id, ip_address, endpoint, result, reason)
       VALUES ($1, $2, $3, now(), 'admin_console', $4, $5, $6, $7, $8)`,
      [
        input.actorId,
        input.targetId,
        input.action,
        input.correlationId,
        truncateIp(input.ipAddress ?? null),
        input.endpoint ?? null,
        input.result ?? "success",
        input.reason,
      ],
    );
  }

  async issueStepUpChallenge(input: {
    userId: string;
    method: "totp" | "backup_code";
    correlationId: string;
  }): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashStepUpToken(token);
    await this.withActor(input.userId, async () => {
      await this.query(
        `INSERT INTO admin_step_up_challenge
          (user_id, token_hash, method, issued_at, expires_at, correlation_id)
         VALUES ($1, $2, $3, now(), now() + interval '5 minutes', $4)`,
        [input.userId, tokenHash, input.method, input.correlationId],
      );
    });
    return token;
  }

  async executeIdempotent<T>(
    scope: string,
    key: string,
    request: unknown,
    run: () => Promise<T>,
    actorId?: string,
    stepUpToken?: string,
  ): Promise<{ replayed: boolean; result: T }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.configureClient(client, actorId);
      const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO idempotency_key (scope, key, request_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '24 hours')
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [scope, key, requestHash],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          request_hash: string;
          status_code: number | null;
          response: T | null;
        }>(
          `SELECT request_hash, status_code, response
             FROM idempotency_key
            WHERE scope = $1 AND key = $2
            FOR UPDATE`,
          [scope, key],
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) throw new AdminIdempotencyConflictError();
        if (row.status_code === null) {
          throw new Error("Idempotent command is still in progress");
        }
        await client.query("COMMIT");
        return { replayed: true, result: row.response as T };
      }
      if (!actorId || !stepUpToken) throw new AdminPolicyError("step_up_required");
      const consumed = await client.query(
        `UPDATE admin_step_up_challenge
            SET consumed_at = now()
          WHERE user_id = $1
            AND token_hash = $2
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING id`,
        [actorId, hashStepUpToken(stepUpToken)],
      );
      if (consumed.rowCount !== 1) throw new AdminPolicyError("step_up_required");
      const result = await this.transaction.run(client, run);
      await client.query(
        `UPDATE idempotency_key
            SET status_code = 200, response = $3
          WHERE scope = $1 AND key = $2`,
        [scope, key, result],
      );
      await client.query("COMMIT");
      return { replayed: false, result };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async executeEmailIdempotent<T>(
    scope: string,
    key: string,
    request: unknown,
    run: () => Promise<AdminEmailCommand<T>>,
    send: (email: string) => Promise<void>,
    audit: AdminEmailDeliveryAudit,
    actorId?: string,
    stepUpToken?: string,
  ): Promise<{ replayed: boolean; result: T }> {
    const client = await this.pool.connect();
    let delivery: { email: string; result: T; status: string } | undefined;
    let replayed = false;
    try {
      await client.query("BEGIN");
      await this.configureClient(client, actorId);
      const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO idempotency_key (scope, key, request_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '24 hours')
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [scope, key, requestHash],
      );
      if (inserted.rowCount === 1) {
        if (!actorId || !stepUpToken) throw new AdminPolicyError("step_up_required");
        const consumed = await client.query(
          `UPDATE admin_step_up_challenge
              SET consumed_at = now()
            WHERE user_id = $1
              AND token_hash = $2
              AND consumed_at IS NULL
              AND expires_at > now()
            RETURNING id`,
          [actorId, hashStepUpToken(stepUpToken)],
        );
        if (consumed.rowCount !== 1) throw new AdminPolicyError("step_up_required");
        const command = await this.transaction.run(client, run);
        await client.query(
          `INSERT INTO admin_email_delivery
            (scope, key, request_hash, actor_id, target_id, action, email, reason,
             correlation_id, ip_address, endpoint, status, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 0)`,
          [
            scope,
            key,
            requestHash,
            audit.actorId,
            audit.targetId,
            audit.action,
            command.email,
            audit.reason,
            audit.correlationId,
            truncateIp(audit.ipAddress ?? null),
            audit.endpoint ?? null,
          ],
        );
        await client.query(
          `UPDATE idempotency_key
              SET status_code = 202, response = $3
            WHERE scope = $1 AND key = $2`,
          [scope, key, command.result],
        );
        delivery = { email: command.email, result: command.result, status: "pending" };
      } else {
        const existing = await client.query<{
          request_hash: string;
          status_code: number | null;
          response: T | null;
        }>(
          `SELECT request_hash, status_code, response
             FROM idempotency_key
            WHERE scope = $1 AND key = $2
            FOR UPDATE`,
          [scope, key],
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) throw new AdminIdempotencyConflictError();
        if (row.status_code === null) throw new Error("Idempotent command is still in progress");
        if (row.status_code === 200) {
          await client.query("COMMIT");
          return { replayed: true, result: row.response as T };
        }
        const pending = await client.query<{
          actor_id: string;
          email: string;
          status: string;
        }>(
          `SELECT actor_id, email, status
             FROM admin_email_delivery
            WHERE scope = $1 AND key = $2
            FOR UPDATE`,
          [scope, key],
        );
        const outbox = pending.rows[0];
        if (!outbox || outbox.actor_id !== actorId) throw new AdminIdempotencyConflictError();
        if (outbox.status === "sent") {
          await client.query(
            `UPDATE idempotency_key SET status_code = 200 WHERE scope = $1 AND key = $2`,
            [scope, key],
          );
          await client.query("COMMIT");
          return { replayed: true, result: row.response as T };
        }
        delivery = { email: outbox.email, result: row.response as T, status: outbox.status };
        replayed = true;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!delivery) throw new Error("Email delivery intent was not created");
    try {
      await send(delivery.email);
      await this.finishEmailDelivery(scope, key, actorId, true);
    } catch (error) {
      await this.finishEmailDelivery(scope, key, actorId, false, error).catch(() => undefined);
      throw error;
    }
    return { replayed, result: delivery.result };
  }

  private async finishEmailDelivery(
    scope: string,
    key: string,
    actorId: string | undefined,
    sent: boolean,
    error?: unknown,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.configureClient(client, actorId);
      const delivery = await client.query<{
        actor_id: string;
        target_id: string;
        action: string;
        reason: string;
        correlation_id: string;
        ip_address: string | null;
        endpoint: string | null;
        status: string;
      }>(
        `SELECT actor_id, target_id, action, reason, correlation_id, ip_address, endpoint, status
           FROM admin_email_delivery
          WHERE scope = $1 AND key = $2
          FOR UPDATE`,
        [scope, key],
      );
      const row = delivery.rows[0];
      if (!row) throw new Error("Email delivery intent not found");
      if (row.status === "sent") {
        await client.query("COMMIT");
        return;
      }
      const message = error instanceof Error ? error.message.slice(0, 500) : null;
      await client.query(
        `UPDATE admin_email_delivery
            SET status = $3,
                attempts = attempts + 1,
                last_error = $4,
                sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END,
                updated_at = now()
          WHERE scope = $1 AND key = $2`,
        [scope, key, sent ? "sent" : "failed", sent ? null : message],
      );
      if (sent) {
        await client.query(
          `UPDATE idempotency_key SET status_code = 200 WHERE scope = $1 AND key = $2`,
          [scope, key],
        );
      }
      await client.query(
        `INSERT INTO platform_audit_event
          (actor_id, target_id, action, occurred_at, origin, correlation_id, ip_address, endpoint, result, reason)
         VALUES ($1, $2, $3, now(), 'admin_console', $4, $5, $6, $7, $8)`,
        [
          row.actor_id,
          row.target_id,
          row.action,
          row.correlation_id,
          row.ip_address,
          row.endpoint,
          sent ? "success" : "failure",
          sent ? row.reason : `${row.reason} (${message ?? "email delivery failed"})`,
        ],
      );
      await client.query("COMMIT");
    } catch (finishError) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw finishError;
    } finally {
      client.release();
    }
  }

  private async fetchAccount(userId: string): Promise<AdminAccountDetail | null> {
    const result = await this.query<AccountRow>(
      `SELECT u.id AS user_id,
              u.name,
              u.email,
              p.role,
              p.status,
              u.created_at,
              md.last_activity_at,
              md.workspace_count::text AS workspace_count,
              md.active_session_count::text AS active_session_count
         FROM "user" u
         LEFT JOIN platform_account p ON p.user_id = u.id
         LEFT JOIN LATERAL app.platform_account_metadata(u.id) md ON true
        WHERE u.id = $1
        `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const summary = toAccountSummary(row);
    const [workspaces, sessions] = await Promise.all([
      this.query<WorkspaceRow>(
        `SELECT id, name, status
           FROM app.platform_account_workspaces($1)`,
        [userId],
      ),
      this.query<SessionRow>(
        `SELECT id, created_at, updated_at, expires_at, ip_address, user_agent
           FROM session
          WHERE user_id = $1 AND expires_at > now()
          ORDER BY updated_at DESC NULLS LAST, id`,
        [userId],
      ),
    ]);
    return {
      ...summary,
      workspaces: workspaces.rows.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        status:
          workspace.status === "deletion_pending" || workspace.status === "deactivated"
            ? workspace.status
            : "active",
      })),
      sessions: sessions.rows.map((session) => ({
        id: session.id,
        createdAt: session.created_at.toISOString(),
        updatedAt: session.updated_at?.toISOString() ?? null,
        expiresAt: session.expires_at.toISOString(),
        ipAddress: truncateIp(session.ip_address),
        userAgent: session.user_agent,
      })),
    };
  }

  private async lockAndProtectLastAdmin(targetUserId: string): Promise<void> {
    const admins = await this.query<{ user_id: string }>(
      `SELECT user_id
         FROM platform_account
        WHERE role = 'platform_admin' AND status = 'active'
        ORDER BY user_id
        FOR UPDATE`,
    );
    const targetIsLast = admins.rows.length <= 1 && admins.rows[0]?.user_id === targetUserId;
    if (targetIsLast) throw new AdminPolicyError("last_platform_admin");
  }

  private async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    const client = this.transaction.getStore();
    if (!client) throw new Error("Admin store query requires an actor transaction");
    return client.query<T>(text, values);
  }

  private async configureClient(client: PoolClient, actorId?: string): Promise<void> {
    if (this.applicationRole) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.applicationRole)) {
        throw new Error("Invalid PostgreSQL role identifier");
      }
      const quotedRole = this.applicationRole.replaceAll('"', '""');
      await client.query(`SET LOCAL ROLE "${quotedRole}"`);
    }
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId ?? ""]);
  }
}

/**
 * Durable fixed-window limiter for administrative requests. The bucket is
 * actor-scoped and protected by RLS, so a restart or a second API instance
 * cannot reset the limit.
 */
export class PostgresAdminRateLimiter implements AdminRateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly applicationRole = "casei_app",
    private readonly limit = 60,
    private readonly windowSeconds = 60,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Admin rate limit must be a positive integer");
    }
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
      throw new RangeError("Admin rate-limit window must be a positive integer");
    }
  }

  async consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.applicationRole)) {
        throw new Error("Invalid PostgreSQL role identifier");
      }
      await client.query(`SET LOCAL ROLE "${this.applicationRole.replaceAll('"', '""')}"`);
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [key]);
      const result = await client.query<{
        attempts: number;
        window_started_at: Date;
      }>(
        `INSERT INTO admin_rate_limit_bucket (actor_id, window_started_at, attempts)
         VALUES ($1, now(), 1)
         ON CONFLICT (actor_id) DO UPDATE
           SET attempts = CASE
             WHEN admin_rate_limit_bucket.window_started_at <= now() - ($3 * interval '1 second')
               THEN 1
             ELSE LEAST($2, admin_rate_limit_bucket.attempts + 1)
           END,
           window_started_at = CASE
             WHEN admin_rate_limit_bucket.window_started_at <= now() - ($3 * interval '1 second')
               THEN now()
             ELSE admin_rate_limit_bucket.window_started_at
           END
         RETURNING attempts, window_started_at`,
        [key, this.limit + 1, this.windowSeconds],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) throw new Error("Rate-limit bucket was not returned");
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (new Date(row.window_started_at).getTime() + this.windowSeconds * 1_000 - Date.now()) /
            1_000,
        ),
      );
      return { allowed: row.attempts <= this.limit, retryAfterSeconds };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function decodePosition(cursor: string | undefined, ordering: string): [string, string] | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor, ADMIN_CURSOR_SECRET);
  if (
    decoded.ordering !== ordering ||
    !Array.isArray(decoded.position) ||
    decoded.position.length !== 2 ||
    typeof decoded.position[0] !== "string" ||
    typeof decoded.position[1] !== "string"
  ) {
    throw new InvalidCursorError();
  }
  return [decoded.position[0], decoded.position[1]];
}

function toAdminJobSummary(row: JobRow): AdminJobSummary {
  const type =
    row.job_type === "data.import" || row.job_type === "recurrence.expand"
      ? row.job_type
      : "data.import";
  const state = row.state as AdminJobSummary["state"];
  return {
    id: row.id,
    type,
    version: row.job_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    requiredCapability: row.required_capability,
    state,
    attempts: row.attempts,
    availableAt: row.available_at.toISOString(),
    leaseUntil: row.lease_until?.toISOString() ?? null,
    correlationId: row.correlation_id,
    lastError: sanitizeJobError(row.last_error),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    retryable:
      (state === "failed" || state === "dead") &&
      (type === "data.import" || type === "recurrence.expand"),
  };
}

function toAdminAuditEvent(row: AuditRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    targetId: row.target_id,
    action: row.action,
    occurredAt: row.occurred_at.toISOString(),
    origin: row.origin,
    correlationId: row.correlation_id,
    ipAddress: row.ip_address,
    endpoint: row.endpoint,
    result: row.result === "failure" ? "failure" : "success",
    reason: row.reason.slice(0, 500),
  } as const;
}

function sanitizeJobError(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function hashStepUpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAccountSummary(row: AccountRow): AdminAccountSummary {
  return {
    userId: row.user_id,
    displayName: row.name,
    email: row.email,
    role: row.role === "platform_admin" || row.role === "platform_support" ? row.role : null,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    workspaceCount: Number(row.workspace_count),
    activeSessionCount: Number(row.active_session_count),
  };
}

function truncateIp(value: string | null): string | null {
  const normalized = value?.trim().split("%", 1)[0];
  if (!normalized) return null;
  if (isIP(normalized) === 6) {
    const separator = normalized.indexOf("::");
    const head = separator >= 0 ? normalized.slice(0, separator) : normalized;
    const tail = separator >= 0 ? normalized.slice(separator + 2) : "";
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return "redacted";
    const groups = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
      return "redacted";
    }
    return `${groups
      .slice(0, 4)
      .map((group) => Number.parseInt(group, 16).toString(16))
      .join(":")}::/64`;
  }
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".");
    return `${parts.slice(0, 3).join(".")}.0/24`;
  }
  return "redacted";
}
