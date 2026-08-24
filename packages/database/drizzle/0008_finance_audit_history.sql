ALTER TABLE "audit_event"
  ADD COLUMN "before_redacted" jsonb,
  ADD COLUMN "after_redacted" jsonb;
--> statement-breakpoint
-- Audit history is append-only; reads and inserts remain available to the application role.
REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM casei_app;
