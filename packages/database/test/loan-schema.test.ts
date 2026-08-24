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
  const purgeHardening = await readFile(
    fileURLToPath(new URL("../drizzle/0015_loan_purge_hardening.sql", import.meta.url)),
    "utf8",
  );
  const purgeHardeningDown = await readFile(
    fileURLToPath(new URL("../drizzle/0015_loan_purge_hardening.down.sql", import.meta.url)),
    "utf8",
  );
  const referenceHardening = await readFile(
    fileURLToPath(new URL("../drizzle/0016_loan_reference_hardening.sql", import.meta.url)),
    "utf8",
  );
  const referenceHardeningDown = await readFile(
    fileURLToPath(new URL("../drizzle/0016_loan_reference_hardening.down.sql", import.meta.url)),
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
  assert.match(journal, /"idx": 14[\s\S]*"tag": "0014_stock_purchase_finance_link"/i);
  assert.match(journal, /"idx": 15[\s\S]*"tag": "0015_loan_purge_hardening"/i);
  assert.match(journal, /"idx": 16[\s\S]*"tag": "0016_loan_reference_hardening"/i);
  assert.match(purgeHardening, /CREATE OR REPLACE FUNCTION app\.purge_workspace_loans/i);
  assert.match(purgeHardening, /SECURITY DEFINER/i);
  assert.match(purgeHardening, /ON DELETE CASCADE/i);
  assert.match(purgeHardening, /REVOKE UPDATE, DELETE ON TABLE "loan_payment"/i);
  assert.match(purgeHardening, /REVOKE UPDATE, DELETE ON TABLE "ledger_event", "ledger_entry"/i);
  assert.match(purgeHardeningDown, /ON DELETE RESTRICT/i);
  assert.match(purgeHardeningDown, /DROP FUNCTION IF EXISTS app\.purge_workspace_loans/i);
  assert.match(
    referenceHardening,
    /CREATE OR REPLACE FUNCTION app\.guard_loan_contract_event_reference/i,
  );
  assert.match(referenceHardening, /CREATE TRIGGER loan_payment_reference_guard/i);
  assert.match(referenceHardening, /principal_event_id/i);
  assert.match(referenceHardening, /event_type LIKE 'loan\.%'/i);
  assert.match(referenceHardening, /transaction_id IS NULL/i);
  assert.match(referenceHardening, /RAISE EXCEPTION/i);
  assert.match(
    referenceHardeningDown,
    /DROP TRIGGER IF EXISTS loan_contract_event_reference_guard/i,
  );
});
