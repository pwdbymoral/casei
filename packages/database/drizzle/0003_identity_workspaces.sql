ALTER TABLE "workspace_preference"
  ADD COLUMN "initial_balance_minor" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_event"
  ADD COLUMN "retention_until" timestamp with time zone;
--> statement-breakpoint
UPDATE "audit_event"
   SET "retention_until" = "occurred_at" + interval '365 days'
 WHERE "retention_until" IS NULL;
--> statement-breakpoint
CREATE INDEX "audit_event_retention_idx" ON "audit_event" USING btree ("retention_until");
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
CREATE TABLE "workspace_invitation_rate_limit" (
  "workspace_id" uuid NOT NULL,
  "actor_user_id" text NOT NULL,
  "action" text NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "workspace_invitation_rate_limit_action_check" CHECK ("action" in ('create', 'resend')),
  CONSTRAINT "workspace_invitation_rate_limit_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "workspace_invitation_rate_limit_pk" PRIMARY KEY ("workspace_id", "actor_user_id", "action")
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
  "backup_expires_at" timestamp with time zone NOT NULL,
  "audit_purge_at" timestamp with time zone NOT NULL,
  CONSTRAINT "workspace_tombstone_status_check" CHECK ("status" = 'deactivated')
);
--> statement-breakpoint
ALTER TABLE "workspace_invitation" ADD CONSTRAINT "workspace_invitation_workspace_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "workspace_invitation_rate_limit" ADD CONSTRAINT "workspace_invitation_rate_limit_workspace_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade;
ALTER TABLE "workspace_invitation_rate_limit" ADD CONSTRAINT "workspace_invitation_rate_limit_actor_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
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
CREATE INDEX "workspace_invitation_rate_limit_window_idx" ON "workspace_invitation_rate_limit" USING btree ("window_started_at");
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
    SELECT 1
      FROM membership m
      JOIN workspace w ON w.id = m.workspace_id
     WHERE m.workspace_id = candidate
       AND m.user_id = app.current_actor_id()
       AND m.status = 'active'
       AND w.status = 'active'
    UNION ALL
    SELECT 1
      FROM membership m
      JOIN workspace w ON w.id = m.workspace_id
      JOIN workspace_deletion_recovery r ON r.workspace_id = w.id
     WHERE m.workspace_id = candidate
       AND m.user_id = app.current_actor_id()
       AND m.role = 'owner'
       AND m.status = 'recovery_only'
       AND w.status = 'deletion_pending'
       AND r.owner_user_id = m.user_id
       AND r.status = 'active'
       AND r.expires_at > now()
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."current_actor_email"() TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."actor_has_workspace"(uuid) TO casei_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitation", "workspace_deletion_recovery" TO casei_app;
GRANT SELECT, INSERT ON "workspace_tombstone" TO casei_app;
--> statement-breakpoint
DROP POLICY "job_scope" ON "job";
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
  USING (
    workspace_id = "app"."current_workspace_id"()
    OR (
      owner_user_id = "app"."current_actor_id"()
      AND status = 'active'
      AND expires_at > now()
      AND EXISTS (
        SELECT 1 FROM workspace w
        WHERE w.id = workspace_deletion_recovery.workspace_id
          AND w.status = 'deletion_pending'
      )
    )
  )
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
    OR (
      user_id = "app"."current_actor_id"()
      AND status = 'active'
    )
    OR (
      user_id = "app"."current_actor_id"()
      AND status = 'recovery_only'
      AND role = 'owner'
      AND EXISTS (
        SELECT 1 FROM workspace w
        WHERE w.id = membership.workspace_id
          AND w.status = 'deletion_pending'
      )
    )
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
CREATE OR REPLACE FUNCTION "app"."assert_workspace_restore_allowed"(candidate uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_tombstone WHERE workspace_id = candidate) THEN
    RAISE EXCEPTION 'workspace tombstone prevents restore' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."assert_workspace_backup_allowed"(candidate uuid, observed_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace_tombstone
     WHERE workspace_id = candidate
       AND observed_at >= backup_expires_at
  ) THEN
    RAISE EXCEPTION 'workspace backup retention expired' USING ERRCODE = '22023';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."detach_workspace_audit"(candidate uuid, until_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
DECLARE
  detached integer;
BEGIN
  UPDATE audit_event
     SET workspace_id = NULL,
         retention_until = until_at
   WHERE workspace_id = candidate;
  GET DIAGNOSTICS detached = ROW_COUNT;
  RETURN detached;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."purge_expired_audit_events"(cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM audit_event
   WHERE retention_until IS NOT NULL
     AND retention_until <= cutoff;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."prevent_workspace_tombstone_rehydration"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  PERFORM app.assert_workspace_restore_allowed(NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_tombstone_rehydration_guard"
BEFORE INSERT ON "workspace"
FOR EACH ROW EXECUTE FUNCTION "app"."prevent_workspace_tombstone_rehydration"();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitation_rate_limit" TO casei_app;
GRANT SELECT, INSERT, DELETE ON "workspace_tombstone" TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."assert_workspace_restore_allowed"(uuid) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."assert_workspace_backup_allowed"(uuid, timestamptz) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."detach_workspace_audit"(uuid, timestamptz) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."purge_expired_audit_events"(timestamptz) TO casei_app;
--> statement-breakpoint
ALTER TABLE "workspace_invitation_rate_limit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_invitation_rate_limit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_invitation_rate_limit_scope" ON "workspace_invitation_rate_limit"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
