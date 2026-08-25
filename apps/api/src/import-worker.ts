import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "@casei/database";

import { createImportWorker, type ImportCommandPort, type ImportSource } from "./import-service.js";

const pollMilliseconds = Number.parseInt(process.env.IMPORT_WORKER_POLL_MS ?? "5000", 10);

/**
 * Runtime-owned adapters are deliberately supplied by the deployment bootstrap.
 * DATA-004 never guesses how a storage object or domain command is wired.
 */
export interface ImportWorkerBootstrap {
  readonly pool: Pool;
  readonly source: ImportSource;
  readonly commands: ImportCommandPort;
  readonly applicationRole?: string;
  readonly batchSize?: number;
}

export type ImportWorkerBootstrapFactory = () =>
  | ImportWorkerBootstrap
  | Promise<ImportWorkerBootstrap>;

/** Claims and executes all eligible DATA-004 jobs once, grouped by workspace. */
export async function runImportWorkerOnce(
  bootstrap: ImportWorkerBootstrap,
  at = new Date(),
): Promise<number> {
  const worker = createImportWorker(bootstrap);
  const workspaces = await bootstrap.pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id
       FROM "job"
      WHERE job_type = 'data.import' AND job_version = 1
        AND (
          (state IN ('pending', 'failed') AND available_at <= clock_timestamp())
          OR (state = 'running' AND lease_until <= clock_timestamp())
        )
        AND workspace_id IS NOT NULL
      ORDER BY workspace_id`,
  );
  let processed = 0;
  for (const row of workspaces.rows) {
    const result = await worker.runOnce(row.workspace_id, at);
    if (result.state !== "idle") processed += 1;
  }
  return processed;
}

async function loadBootstrap(): Promise<ImportWorkerBootstrap> {
  const modulePath = process.env.CASEI_IMPORT_WORKER_BOOTSTRAP;
  if (!modulePath) {
    throw new Error("CASEI_IMPORT_WORKER_BOOTSTRAP is required for the import worker");
  }
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    createImportWorkerBootstrap?: ImportWorkerBootstrapFactory;
  };
  if (typeof loaded.createImportWorkerBootstrap !== "function") {
    throw new Error("The import worker bootstrap must export createImportWorkerBootstrap()");
  }
  return loaded.createImportWorkerBootstrap();
}

async function main(): Promise<void> {
  const bootstrap = await loadBootstrap();
  const runBatch = () =>
    runImportWorkerOnce(bootstrap).catch(() => {
      console.error("import worker failed");
      return 0;
    });
  await runBatch();
  const timer = setInterval(
    () => void runBatch(),
    Number.isFinite(pollMilliseconds) && pollMilliseconds > 0 ? pollMilliseconds : 5000,
  );
  timer.unref();
}

if (process.argv[1] && /import-worker\.(?:ts|js)$/.test(process.argv[1])) {
  void main().catch(() => {
    console.error("import worker startup failed");
    process.exitCode = 1;
  });
}
