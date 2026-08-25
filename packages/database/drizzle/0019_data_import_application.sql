CREATE TABLE "import_job" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  -- Keep actor provenance after membership/user revocation; authorization is revalidated at every batch.
  "actor_id" text NOT NULL,
  "job_id" uuid REFERENCES "job"("id") ON DELETE SET NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "required_capability" text NOT NULL DEFAULT 'import',
  "domain" text NOT NULL,
  "storage_key" text NOT NULL,
  "source_hash" text NOT NULL,
  "mapping_version" text NOT NULL,
  "preview_hash" text NOT NULL,
  "preview_manifest" jsonb NOT NULL,
  "mode" text NOT NULL,
  "duplicate_policy" text NOT NULL,
  "accepted_duplicate_lines" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "total_rows" integer NOT NULL,
  "valid_rows" integer NOT NULL,
  "duplicate_rows" integer NOT NULL,
  "invalid_rows" integer NOT NULL,
  "applied_rows" integer NOT NULL DEFAULT 0,
  "skipped_rows" integer NOT NULL DEFAULT 0,
  "rejected_rows" integer NOT NULL DEFAULT 0,
  "cursor" integer NOT NULL DEFAULT 0,
  "batch_size" integer NOT NULL DEFAULT 100,
  "state" text NOT NULL DEFAULT 'queued',
  "expires_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "correlation_id" varchar(26) NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "import_job_source_hash_check" CHECK ("source_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "import_job_preview_hash_check" CHECK ("preview_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "import_job_preview_manifest_check" CHECK (jsonb_typeof("preview_manifest") = 'array'),
  CONSTRAINT "import_job_idempotency_key_check" CHECK (length("idempotency_key") between 16 and 128),
  CONSTRAINT "import_job_capability_check" CHECK ("required_capability" = 'import'),
  CONSTRAINT "import_job_duplicate_lines_check" CHECK (jsonb_typeof("accepted_duplicate_lines") = 'array'),
  CONSTRAINT "import_job_domain_check" CHECK ("domain" in ('transactions', 'products', 'full')),
  CONSTRAINT "import_job_mode_check" CHECK ("mode" in ('valid_only', 'all_or_nothing')),
  CONSTRAINT "import_job_duplicate_policy_check" CHECK ("duplicate_policy" in ('skip', 'import', 'review')),
  CONSTRAINT "import_job_state_check" CHECK ("state" in ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'reversing', 'reversed')),
  CONSTRAINT "import_job_counts_check" CHECK (
    "total_rows" between 1 and 50000
    AND "valid_rows" >= 0 AND "duplicate_rows" >= 0 AND "invalid_rows" >= 0
    AND "total_rows" = "valid_rows" + "duplicate_rows" + "invalid_rows"
    AND "applied_rows" >= 0 AND "skipped_rows" >= 0 AND "rejected_rows" >= 0
    AND "cursor" between 0 and "total_rows"
  ),
  CONSTRAINT "import_job_batch_size_check" CHECK ("batch_size" between 1 and 50000),
  CONSTRAINT "import_job_version_check" CHECK ("version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "import_job"
  ADD CONSTRAINT "import_job_workspace_id_unique" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "import_job_workspace_idempotency_unique"
  ON "import_job" ("workspace_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "import_job_workspace_state_idx"
  ON "import_job" ("workspace_id", "state", "updated_at", "id");
--> statement-breakpoint
CREATE TABLE "import_job_line" (
  "job_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "line_number" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "fingerprint" text,
  "target_type" text,
  "target_id" text,
  "reversal_token" text,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("job_id", "line_number"),
  CONSTRAINT "import_job_line_job_fk" FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "import_job" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "import_job_line_number_check" CHECK ("line_number" >= 2 and "line_number" <= 50001),
  CONSTRAINT "import_job_line_status_check" CHECK ("status" in ('pending', 'applied', 'skipped', 'rejected', 'reversed')),
  CONSTRAINT "import_job_line_error_check" CHECK (
    ("status" in ('rejected', 'skipped') AND "error_code" IS NOT NULL)
    OR ("status" in ('pending', 'applied', 'reversed'))
  )
);
--> statement-breakpoint
CREATE INDEX "import_job_line_workspace_status_idx"
  ON "import_job_line" ("workspace_id", "job_id", "status", "line_number");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "import_job", "import_job_line" TO casei_app;
--> statement-breakpoint
ALTER TABLE "import_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_job_scope" ON "import_job"
  USING ("workspace_id" = "app"."current_workspace_id"())
  WITH CHECK ("workspace_id" = "app"."current_workspace_id"());
--> statement-breakpoint
ALTER TABLE "import_job_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_job_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_job_line_scope" ON "import_job_line"
  USING ("workspace_id" = "app"."current_workspace_id"())
  WITH CHECK ("workspace_id" = "app"."current_workspace_id"());
