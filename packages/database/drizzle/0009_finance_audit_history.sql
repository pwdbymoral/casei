-- Snapshots are added by 0005_audit_redacted_fields. This migration only tightens
-- the application role after the finance audit history is exposed.
REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM casei_app;
