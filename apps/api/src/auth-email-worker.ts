import { createDatabase } from "@casei/database";

import {
  DrizzleAuthEmailIntentStore,
  NodemailerTransactionalEmailPort,
  processPendingAuthEmails,
  smtpConfigFromEnvironment,
  verifyTransactionalEmailPort,
} from "./auth-email.js";

const pollMilliseconds = Number.parseInt(process.env.AUTH_EMAIL_WORKER_POLL_MS ?? "5000", 10);

function createWorkerResources() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for the auth email worker");
  const database = createDatabase();
  const store = new DrizzleAuthEmailIntentStore(database, secret);
  const transport = new NodemailerTransactionalEmailPort(smtpConfigFromEnvironment());
  return { store, transport };
}

/** Process one batch so orchestration can run this handler under its own lease/supervision. */
export async function runAuthEmailWorkerOnce(): Promise<number> {
  const resources = createWorkerResources();
  const { store, transport } = resources;
  await verifyTransactionalEmailPort(transport);
  return processPendingAuthEmails(store, transport);
}

/** Standalone durable worker process. It never runs in the API process. */
async function main(): Promise<void> {
  let resources: ReturnType<typeof createWorkerResources>;
  try {
    resources = createWorkerResources();
    await verifyTransactionalEmailPort(resources.transport);
  } catch {
    console.error("auth email worker startup failed");
    process.exitCode = 1;
    return;
  }
  const runBatch = () => processPendingAuthEmails(resources.store, resources.transport);
  await runBatch();
  const timer = setInterval(
    () => {
      void runBatch().catch(() => {
        console.error("auth email worker failed");
      });
    },
    Number.isFinite(pollMilliseconds) && pollMilliseconds > 0 ? pollMilliseconds : 5000,
  );
  timer.unref();
}

if (process.argv[1] && /auth-email-worker\.(?:ts|js)$/.test(process.argv[1])) void main();
