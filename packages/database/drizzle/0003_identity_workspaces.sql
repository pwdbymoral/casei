ALTER TABLE "workspace_preference"
  ADD COLUMN "initial_balance_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "workspace_invitation" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL,
  "role" text NOT NULL,
  "invited_by" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_by" text,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "workspace_invitation_role_check" CHECK ("role" in ('member', 'viewer')),
  CONSTRAINT "workspace_invitation_status_check" CHECK ("status" in ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workspace_deletion_recovery" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "owner_user_id" text NOT NULL,
  "entitlement" text DEFAULT 'workspace_deletion_recovery' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "canceled_at" timestamp with time zone,
  CONSTRAINT "workspace_deletion_recovery_status_check" CHECK ("status" in ('active', 'canceled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workspace_tombstone" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "pseudonymous_owner_hash" text NOT NULL,
  "status" text DEFAULT 'deactivated' NOT NULL,
  "deactivated_at" timestamp with time zone NOT NULL,
  "purge_at" timestamp with time zone NOT NULL,
  "audit_purge_at" timestamp with time zone NOT NULL,
  CONSTRAINT "workspace_tombstone_status_check" CHECK ("status" = 'deactivated')
);
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_workspace_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_invited_by_fk"
  FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_accepted_by_fk"
  FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "workspace_deletion_recovery" ADD CONSTRAINT "workspace_deletion_recovery_workspace_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "workspace_deletion_recovery" ADD CONSTRAINT "workspace_deletion_recovery_owner_user_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitation_token_unique" ON "workspace_invitation" USING btree ("token_hash");
CREATE INDEX "workspace_invitation_workspace_status_idx" ON "workspace_invitation" USING btree ("workspace_id", "status");
CREATE INDEX "workspace_invitation_email_idx" ON "workspace_invitation" USING btree ("email", "status");
CREATE UNIQUE INDEX "workspace_invitation_pending_email_unique" ON "workspace_invitation" USING btree ("workspace_id", "email") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "workspace_deletion_recovery_active_unique" ON "workspace_deletion_recovery" USING btree ("workspace_id") WHERE "status" = 'active';
CREATE INDEX "workspace_deletion_recovery_owner_idx" ON "workspace_deletion_recovery" USING btree ("owner_user_id", "status");
CREATE UNIQUE INDEX "membership_active_owner_unique" ON "membership" USING btree ("workspace_id") WHERE "role" = 'owner' AND "status" = 'active';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."current_actor_email"() RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.actor_email', true), ''); $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."actor_has_workspace"(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM membership
     WHERE workspace_id = candidate
       AND user_id = app.current_actor_id()
       AND status = 'active'
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."current_actor_email"() TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."actor_has_workspace"(uuid) TO casei_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitation", "workspace_deletion_recovery" TO casei_app;
GRANT SELECT, INSERT ON "workspace_tombstone" TO casei_app;
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_invitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_invitation_scope" ON "workspace_invitation"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "workspace_deletion_recovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_deletion_recovery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_deletion_recovery_scope" ON "workspace_deletion_recovery"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
DROP POLICY "workspace_scope" ON "workspace";
CREATE POLICY "workspace_scope" ON "workspace"
  USING (id = "app"."current_workspace_id"() OR "app"."actor_has_workspace"(id))
  WITH CHECK (id = "app"."current_workspace_id"());
DROP POLICY "workspace_preference_scope" ON "workspace_preference";
CREATE POLICY "workspace_preference_scope" ON "workspace_preference"
  USING (workspace_id = "app"."current_workspace_id"() OR "app"."actor_has_workspace"(workspace_id))
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
DROP POLICY "membership_scope" ON "membership";
CREATE POLICY "membership_scope" ON "membership"
  USING (
    workspace_id = "app"."current_workspace_id"()
    OR (user_id = "app"."current_actor_id"() AND status = 'active')
  )
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."check_workspace_owner_invariant"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_status text;
  owner_count integer;
BEGIN
  SELECT status INTO workspace_status FROM "workspace" WHERE id = COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF workspace_status IS NULL OR workspace_status <> 'active' THEN RETURN NULL; END IF;
  SELECT count(*) INTO owner_count
    FROM "membership"
   WHERE workspace_id = COALESCE(NEW.workspace_id, OLD.workspace_id)
     AND role = 'owner' AND status = 'active';
  IF owner_count <> 1 THEN
    RAISE EXCEPTION 'workspace must have exactly one active owner' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "membership_owner_invariant"
AFTER INSERT OR UPDATE OR DELETE ON "membership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."check_workspace_owner_invariant"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."prevent_workspace_tombstone_rehydration"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_tombstone WHERE workspace_id = NEW.id) THEN
    RAISE EXCEPTION 'workspace tombstone prevents rehydration' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_tombstone_rehydration_guard"
BEFORE INSERT ON "workspace"
FOR EACH ROW EXECUTE FUNCTION "app"."prevent_workspace_tombstone_rehydration"();
