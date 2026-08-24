import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("PLAN-002 migration makes recurrence transaction creation naturally idempotent", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0012_recurrence_engine.sql", import.meta.url)),
    "utf8",
  );
  const down = await readFile(
    fileURLToPath(new URL("../drizzle/0012_recurrence_engine.down.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /finance_transaction_recurrence_date_unique/i);
  assert.match(migration, /recurrence_id.*occurred_on/i);
  assert.match(migration, /WHERE "recurrence_id" IS NOT NULL/i);
  assert.match(migration, /ADD COLUMN "kind" text/i);
  assert.match(migration, /ADD COLUMN "amount_minor" bigint/i);
  assert.match(migration, /recurrence_date_order_check/i);
  assert.match(migration, /job_type = 'recurrence\.expand'/i);
  assert.match(migration, /system\.recurrence/i);
  assert.match(down, /DROP INDEX.*finance_transaction_recurrence_date_unique/i);
  assert.match(down, /DROP POLICY IF EXISTS "job_scope"/i);
  assert.match(down, /job_type = 'workspace\.purge'/i);
  assert.match(journal, /"idx": 12[\s\S]*"tag": "0012_recurrence_engine"/i);
});
