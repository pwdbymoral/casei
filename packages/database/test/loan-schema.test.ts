import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("LOAN-001/002 migration persists scoped IOU contracts and payments", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0013_loans.sql", import.meta.url)),
    "utf8",
  );
  const down = await readFile(
    fileURLToPath(new URL("../drizzle/0013_loans.down.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE "loan_contract"/i);
  assert.match(migration, /CREATE TABLE "loan_payment"/i);
  assert.match(migration, /direction.*'lent'.*'borrowed'/is);
  assert.match(migration, /loan_contract_principal_event_fk/i);
  assert.match(migration, /loan_payment_event_fk/i);
  assert.match(migration, /loan_contract_workspace_status_due_idx/i);
  assert.match(migration, /loan_contract_status_amount_check/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /CREATE POLICY "loan_contract_scope"/i);
  assert.match(migration, /CREATE POLICY "loan_payment_scope"/i);
  assert.match(down, /DROP TABLE IF EXISTS.*loan_payment.*loan_contract/is);
  assert.match(journal, /"idx": 13[\s\S]*"tag": "0013_loans"/i);
});
