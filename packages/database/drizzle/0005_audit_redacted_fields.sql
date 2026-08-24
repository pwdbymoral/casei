ALTER TABLE "audit_event"
  ADD COLUMN "before_redacted" jsonb,
  ADD COLUMN "after_redacted" jsonb;
