-- DATA-006 export jobs use the same fenced PostgreSQL job queue as imports.
-- Discovery is intentionally a narrow SECURITY DEFINER read-only function;
-- workers claim and execute each job under normal workspace RLS.
CREATE OR REPLACE FUNCTION "app"."list_data_export_workspaces"(eligible_at timestamptz)
RETURNS TABLE ("workspace_id" uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT DISTINCT j.workspace_id
    FROM public.job AS j
   WHERE j.job_type = 'data.export'
     AND j.job_version = 1
     AND j.required_capability = 'export'
     AND j.workspace_id IS NOT NULL
     AND (
       (j.state IN ('pending', 'failed') AND j.available_at <= eligible_at)
       OR (j.state = 'running' AND j.lease_until <= eligible_at)
     )
   ORDER BY j.workspace_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."list_data_export_workspaces"(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."list_data_export_workspaces"(timestamptz) TO casei_app;
--> statement-breakpoint
CREATE TABLE "export_job" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "job_id" uuid REFERENCES "job"("id") ON DELETE SET NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "required_capability" text NOT NULL DEFAULT 'export',
  "domain" text NOT NULL,
  "format" text NOT NULL,
  "request" jsonb NOT NULL,
  "file_name" text,
  "storage_key" text,
  "output_sha256" text,
  "output_bytes" integer,
  "total_rows" integer,
  "processed_rows" integer NOT NULL DEFAULT 0,
  "progress" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'queued',
  "expires_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "correlation_id" varchar(26) NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "export_job_capability_check" CHECK ("required_capability" = 'export'),
  CONSTRAINT "export_job_domain_check" CHECK ("domain" in ('transactions', 'products', 'complete')),
  CONSTRAINT "export_job_format_check" CHECK ("format" in ('csv', 'zip')),
  CONSTRAINT "export_job_state_check" CHECK ("state" in ('queued', 'running', 'completed', 'failed', 'expired')),
  CONSTRAINT "export_job_progress_check" CHECK ("progress" between 0 and 100),
  CONSTRAINT "export_job_output_sha256_check" CHECK ("output_sha256" is null or "output_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "export_job_output_bytes_check" CHECK ("output_bytes" is null or "output_bytes" between 1 and 10000000),
  CONSTRAINT "export_job_counts_check" CHECK (
    "total_rows" is null OR ("total_rows" between 0 and 50000 AND "processed_rows" between 0 and "total_rows")
  ),
  CONSTRAINT "export_job_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_job_workspace_idempotency_unique"
  ON "export_job" ("workspace_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE "export_job"
  ADD CONSTRAINT "export_job_workspace_id_unique" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "export_job_workspace_state_idx"
  ON "export_job" ("workspace_id", "state", "updated_at", "id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "export_job" TO casei_app;
--> statement-breakpoint
ALTER TABLE "export_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "export_job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "export_job_scope" ON "export_job"
  USING ("workspace_id" = "app"."current_workspace_id"())
  WITH CHECK ("workspace_id" = "app"."current_workspace_id"());
