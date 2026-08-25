-- Platform authority is deliberately separate from workspace membership. The
-- API sets app.actor_id only after Better Auth has authenticated the request;
-- role decisions below are always resolved from this database, never from a
-- client header or a session-shaped claim.
ALTER TABLE "user"
  ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "twoFactor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "verified" boolean DEFAULT true NOT NULL,
  "failed_verification_count" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp,
  CONSTRAINT "twoFactor_failed_verification_count_check"
    CHECK ("failed_verification_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("user_id");
--> statement-breakpoint
CREATE TABLE "platform_account" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text,
  "status" text DEFAULT 'active' NOT NULL,
  "suspension_reason" text,
  "role_change_reason" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "platform_account_role_check"
    CHECK ("role" IS NULL OR "role" IN ('platform_admin', 'platform_support')),
  CONSTRAINT "platform_account_status_check"
    CHECK ("status" IN ('active', 'suspended')),
  CONSTRAINT "platform_account_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint
CREATE INDEX "platform_account_role_status_idx"
  ON "platform_account" ("role", "status");
--> statement-breakpoint
CREATE TABLE "platform_audit_event" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "actor_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "target_id" text,
  "action" text NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "origin" text NOT NULL,
  "correlation_id" varchar(26) NOT NULL,
  "ip_address" text,
  "endpoint" text,
  "result" text NOT NULL,
  "reason" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_audit_actor_occurred_idx"
  ON "platform_audit_event" ("actor_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "platform_audit_target_occurred_idx"
  ON "platform_audit_event" ("target_id", "occurred_at");
--> statement-breakpoint
CREATE TABLE "admin_step_up_challenge" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "method" text NOT NULL,
  "issued_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "correlation_id" varchar(26) NOT NULL,
  CONSTRAINT "admin_step_up_method_check" CHECK ("method" IN ('totp', 'backup_code')),
  CONSTRAINT "admin_step_up_expiry_check" CHECK ("expires_at" > "issued_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_step_up_token_hash_unique"
  ON "admin_step_up_challenge" ("token_hash");
--> statement-breakpoint
CREATE INDEX "admin_step_up_user_expiry_idx"
  ON "admin_step_up_challenge" ("user_id", "expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."current_platform_role"() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT p.role
    FROM public.platform_account AS p
   WHERE p.user_id = app.current_actor_id()
     AND p.status = 'active'
   LIMIT 1;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."platform_role_for_user"(candidate text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT p.role FROM public.platform_account AS p WHERE p.user_id = candidate;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."platform_status_for_user"(candidate text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT p.status FROM public.platform_account AS p WHERE p.user_id = candidate;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."platform_account_metadata"(candidate text)
RETURNS TABLE(workspace_count bigint, last_activity_at timestamptz, active_session_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  IF app.current_platform_role() NOT IN ('platform_admin', 'platform_support') THEN
    RETURN QUERY SELECT 0::bigint, NULL::timestamptz, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT count(DISTINCT CASE WHEN m.status = 'active' AND w.status = 'active' THEN m.workspace_id END),
           max(s.updated_at),
           count(DISTINCT CASE WHEN s.expires_at > now() THEN s.id END)
      FROM public."user" u
      LEFT JOIN public.membership m ON m.user_id = u.id
      LEFT JOIN public.workspace w ON w.id = m.workspace_id
      LEFT JOIN public.session s ON s.user_id = u.id
     WHERE u.id = candidate;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."platform_account_workspaces"(candidate text)
RETURNS TABLE(id uuid, name text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  IF app.current_platform_role() NOT IN ('platform_admin', 'platform_support') THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT w.id, w.name, w.status
      FROM public.workspace w
      JOIN public.membership m ON m.workspace_id = w.id
     WHERE m.user_id = candidate AND m.status = 'active'
     ORDER BY w.id;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."assert_platform_session_allowed"(candidate text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.platform_account p
     WHERE p.user_id = candidate AND p.status = 'suspended'
  )
  AND EXISTS (SELECT 1 FROM public."user" u WHERE u.id = candidate);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."guard_platform_session_insert"()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('casei.platform.session:' || NEW.user_id, 0));
  IF NOT app.assert_platform_session_allowed(NEW.user_id) THEN
    RAISE EXCEPTION 'platform session is not allowed' USING ERRCODE = '28000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."lock_platform_session_user"(candidate text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, app
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('casei.platform.session:' || candidate, 0));
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "platform_session_guard"
BEFORE INSERT ON "session"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_platform_session_insert"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."claim_first_platform_admin"(candidate text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('casei.platform.bootstrap', 0));
  IF EXISTS (
    SELECT 1 FROM public.platform_account
     WHERE role = 'platform_admin' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'platform bootstrap already completed' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."user" WHERE id = candidate) THEN
    RAISE EXCEPTION 'platform bootstrap user not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.platform_account (user_id, role, status, version)
  VALUES (candidate, 'platform_admin', 'active', 1)
  ON CONFLICT (user_id) DO UPDATE
    SET role = 'platform_admin', status = 'active', version = platform_account.version + 1,
        updated_at = now();
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "public", "app" TO casei_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "twoFactor", "platform_account", "platform_audit_event", "admin_step_up_challenge"
  TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."current_platform_role"() TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."platform_role_for_user"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."platform_status_for_user"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."platform_account_metadata"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."platform_account_workspaces"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."assert_platform_session_allowed"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."lock_platform_session_user"(text) TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."guard_platform_session_insert"() TO casei_app;
GRANT EXECUTE ON FUNCTION "app"."claim_first_platform_admin"(text) TO casei_app;
--> statement-breakpoint
ALTER TABLE "platform_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_account_read_scope" ON "platform_account"
  USING (
    "user_id" = "app"."current_actor_id"()
    OR "app"."current_platform_role"() IN ('platform_admin', 'platform_support')
  )
  WITH CHECK (
    "app"."current_platform_role"() = 'platform_admin'
    OR (
      "app"."current_platform_role"() = 'platform_support'
      AND "role" IS NOT DISTINCT FROM "app"."platform_role_for_user"("user_id")
    )
  );
--> statement-breakpoint
ALTER TABLE "platform_audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_audit_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_audit_event_scope" ON "platform_audit_event"
  USING ("app"."current_platform_role"() IN ('platform_admin', 'platform_support'))
  WITH CHECK (
    "actor_id" = "app"."current_actor_id"()
    AND "app"."current_platform_role"() IN ('platform_admin', 'platform_support')
  );
--> statement-breakpoint
ALTER TABLE "admin_step_up_challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_step_up_challenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "admin_step_up_challenge_scope" ON "admin_step_up_challenge"
  USING ("user_id" = "app"."current_actor_id"())
  WITH CHECK ("user_id" = "app"."current_actor_id"());
--> statement-breakpoint
-- Better Auth owns the two-factor table lifecycle. It already scopes rows by
-- authenticated user, so unlike platform authority tables this table is not
-- RLS-forced through app.actor_id during the auth callback itself.
