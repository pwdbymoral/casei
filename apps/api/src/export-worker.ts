import { getDatabasePool, type Pool } from "@casei/database";
import {
  createS3ObjectStorageFromEnvironment,
  type ObjectStoragePort,
  type StorageEnvironment,
} from "@casei/storage";

import { type ExportSource, PostgresExportSource, runExportWorkerOnce } from "./export-service.js";

const pollMilliseconds = Number.parseInt(process.env.EXPORT_WORKER_POLL_MS ?? "5000", 10);

export interface ExportWorkerBootstrap {
  readonly pool: Pool;
  readonly source: ExportSource;
  readonly storage: ObjectStoragePort;
  readonly environment: StorageEnvironment;
  readonly applicationRole?: string;
}

export function createDefaultExportWorkerBootstrap(): ExportWorkerBootstrap {
  const environment = storageEnvironment(process.env.NODE_ENV);
  const connectionString = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
  const pool = connectionString ? getDatabasePool({ connectionString }) : getDatabasePool();
  const applicationRole = process.env.DATABASE_ROLE ?? "casei_app";
  return {
    pool,
    source: new PostgresExportSource(pool, applicationRole),
    storage: createS3ObjectStorageFromEnvironment(),
    environment,
    applicationRole,
  };
}

/** Claims and executes all eligible DATA-006 export jobs once. */
export { runExportWorkerOnce };

async function main(): Promise<void> {
  const bootstrap = createDefaultExportWorkerBootstrap();
  const runBatch = () =>
    runExportWorkerOnce(bootstrap).catch(() => {
      console.error("export worker failed");
      return 0;
    });
  await runBatch();
  const timer = setInterval(
    () => void runBatch(),
    Number.isFinite(pollMilliseconds) && pollMilliseconds > 0 ? pollMilliseconds : 5000,
  );
  timer.unref();
}

if (process.argv[1] && /export-worker\.(?:ts|js)$/.test(process.argv[1])) {
  void main().catch(() => {
    console.error("export worker startup failed");
    process.exitCode = 1;
  });
}

function storageEnvironment(value: string | undefined): StorageEnvironment {
  if (value === "production") return "prod";
  if (value === "test") return "test";
  if (value === "staging") return "staging";
  return "dev";
}
