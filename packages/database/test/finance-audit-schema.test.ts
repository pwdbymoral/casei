import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("finance audit history migration stores redacted snapshots and is journaled", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0008_finance_audit_history.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "before_redacted" jsonb/i);
  assert.match(migration, /ADD COLUMN "after_redacted" jsonb/i);
  assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE ["']?audit_event/i);
  assert.match(journal, /"tag": "0008_finance_audit_history"/);
});
