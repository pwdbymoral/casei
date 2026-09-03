import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { exportJob } from "../src/schema.js";

test("declares durable export job authorization and bounded output guards", async () => {
  assert.ok(exportJob.id);
  const sql = await readFile(
    fileURLToPath(new URL("../drizzle/0021_data_export_application.sql", import.meta.url)),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "export_job"/);
  assert.match(sql, /list_data_export_workspaces/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /export_job_output_bytes_check/);
  assert.match(sql, /export_job_workspace_idempotency_unique/);
});
