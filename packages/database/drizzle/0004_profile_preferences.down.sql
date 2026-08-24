DROP POLICY IF EXISTS "audit_event_scope" ON "audit_event";
CREATE POLICY "audit_event_scope" ON "audit_event"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
DROP POLICY IF EXISTS "user_preference_scope" ON "user_preference";
DROP TABLE IF EXISTS "user_preference";
