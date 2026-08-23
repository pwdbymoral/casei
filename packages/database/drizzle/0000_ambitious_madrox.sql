CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"workspace_id" uuid,
	"target_type" text NOT NULL,
	"target_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin" text NOT NULL,
	"correlation_id" varchar(26) NOT NULL,
	"result" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "auth_email_intent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"email_hash" text NOT NULL,
	"callback_url" text NOT NULL,
	"correlation_id" varchar(26) NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_intent_state_check" CHECK ("auth_email_intent"."state" in ('pending', 'queued', 'sent', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"intent_id" uuid NOT NULL,
	"message_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_outbox_state_check" CHECK ("auth_email_outbox"."state" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" smallint,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"job_type" text NOT NULL,
	"job_version" integer NOT NULL,
	"workspace_id" uuid,
	"actor_id" text,
	"required_capability" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" text,
	"correlation_id" varchar(26) NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_state_check" CHECK ("job"."state" in ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "membership_role_check" CHECK ("membership"."role" in ('owner', 'member', 'viewer')),
	CONSTRAINT "membership_status_check" CHECK ("membership"."status" in ('active', 'revoked', 'recovery_only'))
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"workspace_id" uuid,
	"actor_id" text,
	"correlation_id" varchar(26) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_status_check" CHECK ("outbox_event"."status" in ('pending', 'published', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_status_check" CHECK ("workspace"."status" in ('active', 'deletion_pending', 'deactivated'))
);
--> statement-breakpoint
CREATE TABLE "workspace_preference" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"timezone" text NOT NULL,
	"safety_margin_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_intent" ADD CONSTRAINT "auth_email_intent_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_intent_id_auth_email_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."auth_email_intent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_preference" ADD CONSTRAINT "workspace_preference_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_workspace_occurred_idx" ON "audit_event" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_occurred_idx" ON "audit_event" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_email_intent_pending_idx" ON "auth_email_intent" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_outbox_source_unique" ON "auth_email_outbox" USING btree ("message_kind","source_id");--> statement-breakpoint
CREATE INDEX "auth_email_outbox_pending_idx" ON "auth_email_outbox" USING btree ("state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_unique" ON "idempotency_key" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_type_idempotency_unique" ON "job" USING btree ("job_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("state","available_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_workspace_user_unique" ON "membership" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_event" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."current_workspace_id"() RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN NULLIF(current_setting('app.workspace_id', true), '')::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."current_actor_id"() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '');
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "public", "app" TO casei_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO casei_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM casei_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."current_workspace_id"() TO casei_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."current_actor_id"() TO casei_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO casei_app;
--> statement-breakpoint
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_scope" ON "workspace"
  USING (id = "app"."current_workspace_id"())
  WITH CHECK (id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "workspace_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_preference" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_preference_scope" ON "workspace_preference"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY "membership_scope" ON "membership"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_event_scope" ON "audit_event"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_event_scope" ON "outbox_event"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "job_scope" ON "job"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
