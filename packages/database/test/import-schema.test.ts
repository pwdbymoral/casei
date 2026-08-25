import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("declares durable import job authorization and line-result guards", async () => {
  const sql = await readFile(
    fileURLToPath(new URL("../drizzle/0019_data_import_application.sql", import.meta.url)),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "import_job"/);
  assert.match(sql, /CREATE TABLE "import_job_line"/);
  assert.match(sql, /"preview_manifest" jsonb NOT NULL/);
  assert.match(sql, /import_job_preview_manifest_check/);
  assert.match(sql, /import_job_batch_size_check.*50000/s);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE/);
  assert.match(sql, /import_job_line_error_check/);
});
