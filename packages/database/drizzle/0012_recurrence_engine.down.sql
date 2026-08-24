DROP INDEX IF EXISTS "finance_transaction_recurrence_date_unique";
ALTER TABLE "recurrence_rule"
  DROP CONSTRAINT IF EXISTS "recurrence_date_order_check",
  DROP CONSTRAINT IF EXISTS "recurrence_amount_check",
  DROP CONSTRAINT IF EXISTS "recurrence_kind_check",
  DROP COLUMN IF EXISTS "description",
  DROP COLUMN IF EXISTS "amount_minor",
  DROP COLUMN IF EXISTS "kind";

DROP POLICY IF EXISTS "job_scope" ON "job";
CREATE POLICY "job_scope" ON "job"
  USING (
    workspace_id = "app"."current_workspace_id"()
    OR (
      job_type = 'workspace.purge'
      AND job_version = 1
      AND actor_id IS NULL
      AND required_capability = 'system.purge'
    )
  )
  WITH CHECK (
    workspace_id = "app"."current_workspace_id"()
    OR (
      job_type = 'workspace.purge'
      AND job_version = 1
      AND actor_id IS NULL
      AND required_capability = 'system.purge'
    )
  );
