DROP POLICY IF EXISTS "job_platform_retry" ON "job";
DROP POLICY IF EXISTS "job_platform_read" ON "job";
DROP POLICY IF EXISTS "job_workspace_scope" ON "job";
--> statement-breakpoint
CREATE POLICY "job_scope" ON "job"
  USING (
    workspace_id = "app"."current_workspace_id"()
    OR (
      job_type = 'workspace.purge'
      AND job_version = 1
      AND actor_id IS NULL
      AND required_capability = 'system.purge'
    )
    OR (
      job_type = 'recurrence.expand'
      AND job_version = 1
      AND actor_id IS NULL
      AND required_capability = 'system.recurrence'
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
    OR (
      job_type = 'recurrence.expand'
      AND job_version = 1
      AND actor_id IS NULL
      AND required_capability = 'system.recurrence'
    )
  );
