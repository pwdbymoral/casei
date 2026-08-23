import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDatabase } from "../src/client.js";
import {
  canonicalJson,
  dispatchOutbox,
  enqueueOutboxEvent,
  executeIdempotent,
  hashRequest,
  IdempotencyConflictError,
  idempotencyScope,
  PostgresJobWorker,
  withUnitOfWork,
} from "../src/command-infra.js";
import { ensureApplicationRole } from "../src/roles.js";

test("canonicaliza requests sem depender da ordem das chaves", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashRequest({ b: 2, a: 1 }), hashRequest({ a: 1, b: 2 }));
  assert.equal(
    idempotencyScope({
      actorId: "user-1",
      workspaceId: "space-1",
      method: "post",
      route: "/transactions",
    }),
    "user-1:space-1:POST:/transactions",
  );
});

const adminUrl = process.env.DATABASE_URL_TEST;

if (!adminUrl) {
  test("infraestrutura de comandos no PostgreSQL", {
    skip: "DATABASE_URL_TEST não configurado",
  }, () => {});
} else {
  test("unit of work, idempotência, outbox e worker respeitam lease e membership", async () => {
    const adminPool = new Pool({ connectionString: adminUrl });
    const databaseName = `casei_plat004_${process.pid}_${Date.now()}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let pool: Pool | undefined;
    let runtimePool: Pool | undefined;
    const runtimeLogin = `casei_plat004_runtime_${process.pid}_${Date.now()}`;
    const runtimePassword = "casei-plat004-runtime-password";

    try {
      await ensureApplicationRole(adminPool);
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      pool = new Pool({ connectionString: databaseUrl.toString() });
      await migrate(createDatabase(pool), {
        migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      });
      await adminPool.query(
        `CREATE ROLE "${runtimeLogin}" LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS`,
      );
      await ensureApplicationRole(adminPool, { grantee: runtimeLogin });
      const runtimeUrl = new URL(databaseUrl);
      runtimeUrl.username = runtimeLogin;
      runtimeUrl.password = runtimePassword;
      runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
      assert.ok(runtimePool);

      const actorId = "user-plat004";
      const workspaceId = (
        await pool.query<{ id: string }>(
          `INSERT INTO "workspace" (name) VALUES ('Casa') RETURNING id`,
        )
      ).rows[0]?.id;
      assert.ok(workspaceId);
      await pool.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ($1, 'Pessoa', 'plat004@example.test', true)`,
        [actorId],
      );
      await pool.query(
        `INSERT INTO "membership" (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [workspaceId, actorId],
      );

      const runtimeIdentity = await withUnitOfWork(
        runtimePool,
        { workspaceId, actorId, applicationRole: "casei_app" },
        async ({ client }) => {
          const result = await client.query<{
            session_user: string;
            current_user: string;
            current_role: string;
          }>(`SELECT session_user, current_user, current_role`);
          return result.rows[0];
        },
      );
      assert.deepEqual(runtimeIdentity, {
        session_user: runtimeLogin,
        current_user: "casei_app",
        current_role: "casei_app",
      });

      const scope = {
        workspaceId,
        actorId,
        applicationRole: "casei_app",
      };
      const first = await withUnitOfWork(pool, scope, async ({ client }) =>
        executeIdempotent(client, {
          scope: "user-plat004:workspace-1:POST:/command",
          key: "0123456789abcdef",
          request: { amount: "100" },
          execute: async () => {
            await client.query(
              `INSERT INTO "audit_event"
                (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
               VALUES ('domain', 'once', $1, $2, 'test', 'once', 'test', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
              [actorId, workspaceId],
            );
            const outbox = await enqueueOutboxEvent(client, {
              eventType: "test.job",
              eventVersion: 1,
              workspaceId,
              actorId,
              requiredCapability: "test.run",
              correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              payload: { amount: "100" },
            });
            return { statusCode: 201, response: { outboxId: outbox.id } };
          },
        }),
      );
      assert.equal(first.replayed, false);
      const replay = await withUnitOfWork(pool, scope, async ({ client }) =>
        executeIdempotent(client, {
          scope: "user-plat004:workspace-1:POST:/command",
          key: "0123456789abcdef",
          request: { amount: "100" },
          execute: async () => ({ statusCode: 500, response: { impossible: true } }),
        }),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.statusCode, 201);
      const nullResponse = await withUnitOfWork(pool, scope, async ({ client }) =>
        executeIdempotent(client, {
          scope: "user-plat004:workspace-1:POST:/null-response",
          key: "null-response-key",
          request: { accepted: true },
          execute: async () => ({ statusCode: 204, response: null }),
        }),
      );
      assert.equal(nullResponse.response, null);
      const nullReplay = await withUnitOfWork(pool, scope, async ({ client }) =>
        executeIdempotent(client, {
          scope: "user-plat004:workspace-1:POST:/null-response",
          key: "null-response-key",
          request: { accepted: true },
          execute: async () => ({ statusCode: 500, response: { impossible: true } }),
        }),
      );
      assert.equal(nullReplay.replayed, true);
      assert.equal(nullReplay.response, null);
      await assert.rejects(
        withUnitOfWork(pool, scope, async ({ client }) =>
          executeIdempotent(client, {
            scope: "user-plat004:workspace-1:POST:/command",
            key: "0123456789abcdef",
            request: { amount: "101" },
            execute: async () => ({ statusCode: 201, response: { impossible: true } }),
          }),
        ),
        IdempotencyConflictError,
      );

      const concurrentKey = "fedcba9876543210";
      const concurrent = await Promise.all(
        [1, 2].map((value) =>
          withUnitOfWork(pool as Pool, scope, async ({ client }) =>
            executeIdempotent(client, {
              scope: "user-plat004:workspace-1:POST:/concurrent",
              key: concurrentKey,
              request: { value: 1 },
              execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, value === 1 ? 30 : 0));
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('domain', 'concurrent', $1, $2, 'test', 'concurrent', 'test', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
                return { statusCode: 201, response: { value: 1 } };
              },
            }),
          ),
        ),
      );
      assert.equal(concurrent.filter((result) => result.replayed).length, 1);
      const concurrentCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "audit_event" WHERE action = 'concurrent'`,
      );
      assert.equal(concurrentCount.rows[0]?.count, "1");

      const dispatch = await dispatchOutbox(pool, {
        ...scope,
        correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      });
      assert.equal(dispatch.published, 1);
      const job = await pool.query<{ id: string; required_capability: string; state: string }>(
        `SELECT id, required_capability, state FROM "job" WHERE job_type = 'test.job'`,
      );
      assert.equal(job.rows[0]?.required_capability, "test.run");
      assert.equal(job.rows[0]?.state, "pending");
      const jobId = job.rows[0]?.id;
      assert.ok(jobId);

      let handled = 0;
      const worker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "test.job:1",
            async (_job, context) => {
              await context.runBatch(async ({ client }) => {
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('job', 'handled', $1, $2, 'test', 'job', 'worker', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
                handled += 1;
              });
            },
          ],
        ]),
        {
          applicationRole: "casei_app",
          authorizeCapability: ({ role, capability }) =>
            role === "owner" && capability === "test.run",
        },
      );
      assert.deepEqual(await worker.runOnce(workspaceId), { state: "succeeded", jobId });
      assert.equal(handled, 1);

      const success = await pool.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM "job" WHERE job_type = 'test.job'`,
      );
      assert.deepEqual(success.rows[0], { state: "succeeded", attempts: 1 });

      await pool.query(
        `INSERT INTO "job"
          (job_type, job_version, workspace_id, actor_id, required_capability,
           idempotency_key, payload, available_at, correlation_id)
         VALUES ('failure.job', 1, $1, $2, 'test.run', 'failure-key', '{}'::jsonb, now(), '01ARZ3NDEKTSV4RRFFQ69G5FAV')`,
        [workspaceId, actorId],
      );
      const failingWorker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "failure.job:1",
            async () => {
              throw new Error("password=secret");
            },
          ],
        ]),
        {
          applicationRole: "casei_app",
          maxAttempts: 2,
          backoffBaseMs: 1,
          random: () => 0,
          authorizeCapability: ({ role }) => role === "owner",
        },
      );
      // Use a small future tolerance because the fixture's `now()` is evaluated by PostgreSQL.
      const retryNow = new Date(Date.now() + 60_000);
      assert.equal((await failingWorker.runOnce(workspaceId, retryNow)).state, "failed");
      const failed = await pool.query<{ state: string; attempts: number; last_error: string }>(
        `SELECT state, attempts, last_error FROM "job" WHERE job_type = 'failure.job'`,
      );
      assert.deepEqual(failed.rows[0], {
        state: "failed",
        attempts: 1,
        last_error: "job_handler_failed",
      });
      assert.equal(
        (await failingWorker.runOnce(workspaceId, new Date(retryNow.valueOf() + 60_000))).state,
        "dead",
      );
      const dead = await pool.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM "job" WHERE job_type = 'failure.job'`,
      );
      assert.deepEqual(dead.rows[0], { state: "dead", attempts: 2 });

      await pool.query(
        `INSERT INTO "job"
          (job_type, job_version, workspace_id, actor_id, idempotency_key, payload,
           state, lease_until, lease_token, correlation_id)
         VALUES ('lease.job', 1, $1, $2, 'lease-key', '{}'::jsonb, 'running', now() - interval '1 minute', 'expired-token', '01ARZ3NDEKTSV4RRFFQ69G5FAV')`,
        [workspaceId, actorId],
      );
      const leaseWorker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "lease.job:1",
            async (_job, context) => {
              await context.runBatch(async () => {});
            },
          ],
        ]),
        { applicationRole: "casei_app", authorizeCapability: ({ role }) => role === "owner" },
      );
      assert.equal((await leaseWorker.runOnce(workspaceId)).state, "succeeded");

      const fenceJob = await pool.query<{ id: string }>(
        `INSERT INTO "job"
          (job_type, job_version, workspace_id, actor_id, required_capability,
           idempotency_key, payload, correlation_id)
         VALUES ('fence.job', 1, $1, $2, 'test.run', 'fence-key', '{}'::jsonb, '01ARZ3NDEKTSV4RRFFQ69G5FAV')
         RETURNING id`,
        [workspaceId, actorId],
      );
      const fenceJobId = fenceJob.rows[0]?.id;
      assert.ok(fenceJobId);
      let callbackEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        callbackEntered = resolve;
      });
      const fencingWorker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "fence.job:1",
            async (_job, context) =>
              context.runBatch(async ({ client, beforeTransition }) => {
                callbackEntered();
                await new Promise((resolve) => setTimeout(resolve, 250));
                await beforeTransition();
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('job', 'fence_should_rollback', $1, $2, 'test', 'fence', 'worker', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
              }),
          ],
        ]),
        {
          applicationRole: "casei_app",
          leaseMs: 100,
          authorizeCapability: ({ role }) => role === "owner",
        },
      );
      const fencingResult = fencingWorker.runOnce(workspaceId);
      await entered;
      assert.deepEqual(await fencingResult, { state: "lease_lost", jobId: fenceJobId });
      const fencingAudit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "audit_event" WHERE target_id = 'fence'`,
      );
      assert.equal(fencingAudit.rows[0]?.count, "0");

      const takeoverWorker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "fence.job:1",
            async (_job, context) =>
              context.runBatch(async ({ client }) => {
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('job', 'fence_takeover', $1, $2, 'test', 'fence', 'worker', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
              }),
          ],
        ]),
        { applicationRole: "casei_app", authorizeCapability: ({ role }) => role === "owner" },
      );
      assert.equal(
        (await takeoverWorker.runOnce(workspaceId, new Date(Date.now() + 60_000))).state,
        "succeeded",
      );
      const takeoverAudit = await pool.query<{ action: string }>(
        `SELECT action FROM "audit_event" WHERE target_id = 'fence' ORDER BY action`,
      );
      assert.deepEqual(takeoverAudit.rows, [{ action: "fence_takeover" }]);

      let firstBatchReached!: () => void;
      let releaseSecondBatch!: () => void;
      const firstBatch = new Promise<void>((resolve) => {
        firstBatchReached = resolve;
      });
      const secondBatch = new Promise<void>((resolve) => {
        releaseSecondBatch = resolve;
      });
      await pool.query(
        `INSERT INTO "job"
          (job_type, job_version, workspace_id, actor_id, required_capability,
           idempotency_key, payload, correlation_id)
         VALUES ('batch.job', 1, $1, $2, 'test.run', 'batch-key', '{}'::jsonb, '01ARZ3NDEKTSV4RRFFQ69G5FAV')`,
        [workspaceId, actorId],
      );
      const batchWorker = new PostgresJobWorker(
        pool,
        new Map([
          [
            "batch.job:1",
            async (_job, context) => {
              await context.runBatch(async ({ client }) => {
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('job', 'first_batch', $1, $2, 'test', 'batch', 'worker', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
              });
              firstBatchReached();
              await secondBatch;
              await context.runBatch(async ({ client }) => {
                await client.query(
                  `INSERT INTO "audit_event"
                    (category, action, actor_id, workspace_id, target_type, target_id, origin, correlation_id, result)
                   VALUES ('job', 'second_batch', $1, $2, 'test', 'batch', 'worker', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'success')`,
                  [actorId, workspaceId],
                );
              });
            },
          ],
        ]),
        { applicationRole: "casei_app", authorizeCapability: ({ role }) => role === "owner" },
      );
      const batchRun = batchWorker.runOnce(workspaceId);
      await firstBatch;
      await pool.query(
        `UPDATE "membership" SET status = 'revoked' WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, actorId],
      );
      releaseSecondBatch();
      assert.equal((await batchRun).state, "cancelled");
      const batchActions = await pool.query<{ action: string }>(
        `SELECT action FROM "audit_event" WHERE target_id = 'batch' ORDER BY action`,
      );
      assert.deepEqual(batchActions.rows, [{ action: "first_batch" }]);
    } finally {
      await runtimePool?.end();
      await pool?.end();
      await adminPool.query(`DROP ROLE IF EXISTS "${runtimeLogin}"`);
      await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });
}
