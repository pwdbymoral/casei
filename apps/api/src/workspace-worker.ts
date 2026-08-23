import { getDatabasePool } from "@casei/database";

import { IdentityService } from "./identity-service.js";

const pollMilliseconds = Number.parseInt(process.env.WORKSPACE_WORKER_POLL_MS ?? "5000", 10);

/**
 * Runs the durable workspace lifecycle jobs. The worker connection must be a
 * deploy-time worker role allowed to SET ROLE to casei_app; it is never the
 * public HTTP process and never receives an actor session.
 */
export async function runWorkspaceWorkerOnce(): Promise<number> {
  const pool = getDatabasePool({
    connectionString: process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL,
  });
  try {
    const service = new IdentityService(pool, {
      applicationRole: process.env.DATABASE_ROLE ?? "casei_app",
    });
    const worker = service.createPurgeWorker();
    const result = await pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id
         FROM job
        WHERE job_type = 'workspace.purge' AND job_version = 1
          AND state IN ('pending', 'failed') AND available_at <= clock_timestamp()
          AND workspace_id IS NOT NULL
        ORDER BY workspace_id`,
    );
    let processed = 0;
    for (const row of result.rows) {
      const outcome = await worker.runOnce(row.workspace_id, new Date());
      if (outcome.state !== "idle") processed += 1;
    }
    return processed;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const runBatch = () =>
    runWorkspaceWorkerOnce().catch(() => {
      console.error("workspace worker failed");
      return 0;
    });
  await runBatch();
  const timer = setInterval(
    () => void runBatch(),
    Number.isFinite(pollMilliseconds) && pollMilliseconds > 0 ? pollMilliseconds : 5000,
  );
  timer.unref();
}

if (process.argv[1] && /workspace-worker\.(?:ts|js)$/.test(process.argv[1])) void main();
