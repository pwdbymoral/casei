import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("ADMIN-001/002 journals platform schema with RLS and Better Auth two-factor storage", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0021_platform_admin_and_step_up.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE "platform_account"/i);
  assert.match(migration, /CREATE TABLE "platform_audit_event"/i);
  assert.match(migration, /CREATE TABLE "twoFactor"/i);
  assert.match(migration, /CREATE TABLE "admin_step_up_challenge"/i);
  assert.match(migration, /CREATE TABLE "admin_email_delivery"/i);
  assert.match(migration, /admin_email_delivery_scope/i);
  assert.match(migration, /pg_advisory_xact_lock|platform.bootstrap/i);
  assert.match(migration, /claim_first_platform_admin/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /current_platform_role/i);
  assert.match(migration, /platform_status_for_user/i);
  assert.match(migration, /platform_account_metadata/i);
  assert.match(migration, /platform_account_workspaces/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(migration, /assert_platform_session_allowed/i);
  assert.match(migration, /platform_session_guard/i);
  assert.match(migration, /lock_platform_session_user/i);
  assert.match(migration, /casei_platform_boundary\s+NOLOGIN\s+NOSUPERUSER\s+NOBYPASSRLS/i);
  assert.match(migration, /ALTER FUNCTION[\s\S]*OWNER TO casei_platform_boundary/i);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION[\s\S]*FROM PUBLIC/i);
  assert.match(migration, /platform_account_boundary/i);
  assert.match(migration, /workspace_platform_boundary/i);
  assert.match(migration, /membership_platform_boundary/i);
  assert.match(migration, /ip_address/i);
  assert.match(migration, /endpoint/i);
  assert.match(journal, /"idx": 21[\s\S]*"tag": "0021_platform_admin_and_step_up"/i);
});
