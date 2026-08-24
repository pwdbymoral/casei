import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("PLAN-001 migration permits repeated partial settlement events only", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0010_plan_partial_settlement.sql", import.meta.url)),
    "utf8",
  );
  const rollback = await readFile(
    fileURLToPath(new URL("../drizzle/0010_plan_partial_settlement.down.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );
  const schema = await readFile(
    fileURLToPath(new URL("../src/schema.ts", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /DROP INDEX ["']ledger_event_transaction_type_unique/i);
  assert.match(migration, /event_type[^\n]*<> 'transaction\.partially_settled\.v1'/i);
  assert.match(journal, /"tag": "0010_plan_partial_settlement"/);
  assert.match(schema, /eventType[^\n]*<> 'transaction\.partially_settled\.v1'/i);
  assert.match(rollback, /DO \$\$/i);
  assert.match(rollback, /HAVING count\(\*\) > 1/i);
  assert.match(rollback, /RAISE EXCEPTION[^;]*cannot rollback 0010_plan_partial_settlement/i);
  assert.ok(rollback.indexOf("RAISE EXCEPTION") < rollback.indexOf("DROP INDEX"));
});
