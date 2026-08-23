DROP TRIGGER IF EXISTS "membership_owner_invariant" ON "membership";
DROP FUNCTION IF EXISTS "app"."check_workspace_owner_invariant"();
DROP TRIGGER IF EXISTS "workspace_tombstone_rehydration_guard" ON "workspace";
DROP FUNCTION IF EXISTS "app"."prevent_workspace_tombstone_rehydration"();
DROP POLICY IF EXISTS "workspace_deletion_recovery_scope" ON "workspace_deletion_recovery";
DROP POLICY IF EXISTS "workspace_invitation_scope" ON "workspace_invitation";
DROP POLICY IF EXISTS "workspace_scope" ON "workspace";
CREATE POLICY "workspace_scope" ON "workspace"
  USING (id = "app"."current_workspace_id"())
  WITH CHECK (id = "app"."current_workspace_id"());
DROP POLICY IF EXISTS "workspace_preference_scope" ON "workspace_preference";
CREATE POLICY "workspace_preference_scope" ON "workspace_preference"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
DROP FUNCTION IF EXISTS "app"."actor_has_workspace"(uuid);
DROP POLICY IF EXISTS "membership_scope" ON "membership";
CREATE POLICY "membership_scope" ON "membership"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
DROP INDEX IF EXISTS "membership_active_owner_unique";
DROP INDEX IF EXISTS "workspace_deletion_recovery_active_unique";
DROP INDEX IF EXISTS "workspace_deletion_recovery_owner_idx";
DROP INDEX IF EXISTS "workspace_invitation_email_idx";
DROP INDEX IF EXISTS "workspace_invitation_pending_email_unique";
DROP INDEX IF EXISTS "workspace_invitation_workspace_status_idx";
DROP INDEX IF EXISTS "workspace_invitation_token_unique";
ALTER TABLE "workspace_deletion_recovery" DROP CONSTRAINT IF EXISTS "workspace_deletion_recovery_owner_user_id_fk";
ALTER TABLE "workspace_deletion_recovery" DROP CONSTRAINT IF EXISTS "workspace_deletion_recovery_workspace_id_fk";
ALTER TABLE "workspace_invitation" DROP CONSTRAINT IF EXISTS "workspace_invitation_accepted_by_fk";
ALTER TABLE "workspace_invitation" DROP CONSTRAINT IF EXISTS "workspace_invitation_invited_by_fk";
ALTER TABLE "workspace_invitation" DROP CONSTRAINT IF EXISTS "workspace_invitation_workspace_id_fk";
DROP TABLE IF EXISTS "workspace_tombstone";
DROP TABLE IF EXISTS "workspace_deletion_recovery";
DROP TABLE IF EXISTS "workspace_invitation";
ALTER TABLE "workspace_preference"
  DROP COLUMN IF EXISTS "onboarding_completed_at",
  DROP COLUMN IF EXISTS "initial_balance_minor";
