ALTER TABLE "audit_event"
  DROP COLUMN IF EXISTS "before_redacted",
  DROP COLUMN IF EXISTS "after_redacted";
