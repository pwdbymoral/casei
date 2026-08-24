import { getDatabasePool } from "@casei/database";

import { FinanceService } from "./finance-service.js";

const pollMilliseconds = Number.parseInt(process.env.RECURRENCE_WORKER_POLL_MS ?? "5000", 10);

/** Schedules and executes one deterministic recurrence expansion batch. */
export async function runRecurrenceWorkerOnce(at = new Date()): Promise<number> {
  const pool = getDatabasePool({
    connectionString: process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL,
  });
  try {
    const service = new FinanceService(pool, {
      applicationRole: process.env.DATABASE_ROLE ?? "casei_app",
    });
    await service.scheduleRecurrenceExpansions(at);
    const worker = service.createRecurrenceWorker();
    const workspaces = await pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id
         FROM job
        WHERE job_type = 'recurrence.expand' AND job_version = 1
          AND actor_id IS NULL AND required_capability = 'system.recurrence'
          AND workspace_id IS NOT NULL
        ORDER BY workspace_id`,
    );
    let processed = 0;
    for (const row of workspaces.rows) {
      const result = await worker.runOnce(row.workspace_id, at);
      if (result.state !== "idle") processed += 1;
    }
    return processed;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const runBatch = () =>
    runRecurrenceWorkerOnce().catch(() => {
      console.error("recurrence worker failed");
      return 0;
    });
  await runBatch();
  setInterval(
    () => void runBatch(),
    Number.isFinite(pollMilliseconds) && pollMilliseconds > 0 ? pollMilliseconds : 5000,
  );
}

if (process.argv[1] && /recurrence-worker\.(?:ts|js)$/.test(process.argv[1])) void main();
