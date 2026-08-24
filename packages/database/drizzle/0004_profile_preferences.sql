CREATE TABLE "user_preference" (
  "user_id" text PRIMARY KEY NOT NULL,
  "locale" text DEFAULT 'pt-BR' NOT NULL,
  "hide_values" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_preference_locale_check" CHECK ("locale" = 'pt-BR'),
  CONSTRAINT "user_preference_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_preference" TO casei_app;
--> statement-breakpoint
ALTER TABLE "user_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_preference" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_preference_scope" ON "user_preference"
  USING (user_id = "app"."current_actor_id"())
  WITH CHECK (user_id = "app"."current_actor_id"());
--> statement-breakpoint
DROP POLICY "audit_event_scope" ON "audit_event";
CREATE POLICY "audit_event_scope" ON "audit_event"
  USING (
    workspace_id = "app"."current_workspace_id"()
    OR (workspace_id IS NULL AND actor_id = "app"."current_actor_id"())
  )
  WITH CHECK (
    workspace_id = "app"."current_workspace_id"()
    OR (workspace_id IS NULL AND actor_id = "app"."current_actor_id"())
  );
