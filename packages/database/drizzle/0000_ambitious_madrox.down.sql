-- Rollback companion for the initial migration.
-- Drizzle applies forward migrations only; operators must review this destructive
-- script before using it outside a disposable database.
DROP SCHEMA IF EXISTS "app" CASCADE;
DROP TABLE IF EXISTS
  "audit_event",
  "auth_email_outbox",
  "auth_email_intent",
  "idempotency_key",
  "job",
  "membership",
  "outbox_event",
  "workspace_preference",
  "workspace",
  "account",
  "session",
  "user",
  "verification"
CASCADE;
DROP SCHEMA IF EXISTS "drizzle" CASCADE;
