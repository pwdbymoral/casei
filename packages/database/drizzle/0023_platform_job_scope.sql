-- Platform operators do not have a workspace context. Keep the ordinary job
-- policy for workspace/system workers, and grant the platform boundary only
-- the narrow read and failed-job retry paths used by the admin console.
DROP POLICY IF EXISTS "job_scope" ON "job";
DROP POLICY IF EXISTS "job_workspace_scope" ON "job";
DROP POLICY IF EXISTS "job_platform_read" ON "job";
DROP POLICY IF EXISTS "job_platform_retry" ON "job";
--> statement-breakpoint
CREATE POLICY "job_workspace_scope" ON "job"
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
--> statement-breakpoint
CREATE POLICY "job_platform_read" ON "job"
  FOR SELECT
  USING ("app"."current_platform_role"() IN ('platform_admin', 'platform_support'));
--> statement-breakpoint
CREATE POLICY "job_platform_retry" ON "job"
  FOR UPDATE
  USING (
    "app"."current_platform_role"() = 'platform_admin'
    AND job_type IN ('data.import', 'recurrence.expand')
    AND state IN ('failed', 'dead')
  )
  WITH CHECK (
    "app"."current_platform_role"() = 'platform_admin'
    AND job_type IN ('data.import', 'recurrence.expand')
    AND state = 'pending'
  );
