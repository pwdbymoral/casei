-- Persist the rule's source values so future job expansion does not depend on
-- whichever occurrence happened to be materialized first.
ALTER TABLE "recurrence_rule"
  ADD COLUMN "kind" text,
  ADD COLUMN "amount_minor" bigint,
  ADD COLUMN "description" text DEFAULT '',
  ADD COLUMN "status" text DEFAULT 'active',
  ADD COLUMN "invalid_reason" text;

-- Rules created before PLAN-002 did not persist their source amount/kind. Use
-- the first materialized occurrence when it is available. An orphan or
-- semantically unsupported rule is retained but archived explicitly so the
-- NOT NULL contract can be enforced without inventing an active commitment.
WITH source AS (
  SELECT r.id,
         t.kind,
         t.amount_minor,
         t.description
    FROM "recurrence_rule" AS r
    LEFT JOIN LATERAL (
      SELECT t.kind, t.amount_minor, t.description
        FROM "finance_transaction" AS t
       WHERE t.recurrence_id = r.id
       ORDER BY t.occurred_on ASC, t.created_at ASC, t.id ASC
       LIMIT 1
    ) AS t ON true
)
UPDATE "recurrence_rule" AS r
   SET "kind" = CASE
                  WHEN source.kind IN ('income', 'expense') THEN source.kind
                  ELSE 'expense'
                END,
       "amount_minor" = CASE
                           WHEN source.amount_minor > 0 THEN source.amount_minor
                           ELSE 1
                         END,
       "description" = COALESCE(source.description, ''),
       "status" = CASE
                    WHEN source.kind IS NULL
                      OR source.kind NOT IN ('income', 'expense')
                      OR source.amount_minor IS NULL
                      OR source.amount_minor <= 0
                      OR (r.end_on IS NOT NULL AND r.end_on < r.start_on)
                    THEN 'archived'
                    ELSE 'active'
                  END,
       "invalid_reason" = NULLIF(concat_ws('; ',
         CASE WHEN source.kind IS NULL THEN 'missing_source_transaction' END,
         CASE WHEN source.kind IS NOT NULL
                   AND source.kind NOT IN ('income', 'expense')
              THEN 'unsupported_source_kind' END,
         CASE WHEN source.amount_minor IS NULL OR source.amount_minor <= 0
              THEN 'missing_or_invalid_amount' END,
         CASE WHEN r.end_on IS NOT NULL AND r.end_on < r.start_on
              THEN 'invalid_date_range' END
       ), '')
  FROM source
 WHERE r.id = source.id;

ALTER TABLE "recurrence_rule"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "amount_minor" SET NOT NULL,
  ALTER COLUMN "description" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "recurrence_rule"
  ADD CONSTRAINT "recurrence_status_check" CHECK ("status" in ('active', 'archived')),
  ADD CONSTRAINT "recurrence_kind_check" CHECK ("status" = 'archived' OR "kind" in ('income', 'expense')),
  ADD CONSTRAINT "recurrence_amount_check" CHECK ("status" = 'archived' OR "amount_minor" > 0),
  ADD CONSTRAINT "recurrence_date_order_check" CHECK ("status" = 'archived' OR "end_on" IS NULL OR "end_on" >= "start_on");

-- A recurrence occurrence is backed by exactly one planned transaction for
-- its civil date. This natural key makes retries/concurrent workers harmless.
CREATE UNIQUE INDEX "finance_transaction_recurrence_date_unique"
  ON "finance_transaction" ("workspace_id", "recurrence_id", "occurred_on")
  WHERE "recurrence_id" IS NOT NULL;

-- The system scheduler must be able to discover active rules even when a
-- previous deployment did not seed an expansion job. It uses the explicit
-- system actor context and remains read-only through this policy.
CREATE POLICY "recurrence_rule_system_scope" ON "recurrence_rule"
  FOR SELECT
  USING ("app"."current_actor_id"() = 'system' AND "status" = 'active');

-- System recurrence workers run without a workspace actor, just like the
-- existing purge worker. Keep the job visible to the fenced completion path.
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

-- Seed one deterministic expansion job for every active rule workspace. This
-- covers recurrence rules created before PLAN-002 had a scheduler, while the
-- runtime scheduler also discovers active rules directly as a repair path.
WITH active_workspaces AS (
  SELECT DISTINCT r.workspace_id,
         (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(p.timezone, 'UTC'))::date AS as_of
    FROM "recurrence_rule" AS r
    LEFT JOIN "workspace_preference" AS p ON p.workspace_id = r.workspace_id
   WHERE r.status = 'active'
)
INSERT INTO "job"
  (job_type, job_version, workspace_id, actor_id, required_capability,
   idempotency_key, payload, available_at, correlation_id)
SELECT 'recurrence.expand', 1, workspace_id, NULL, 'system.recurrence',
       'recurrence-expand:' || workspace_id::text || ':' || as_of::text,
       jsonb_build_object('workspaceId', workspace_id::text, 'asOf', as_of::text),
       now(), '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  FROM active_workspaces
ON CONFLICT (job_type, idempotency_key) DO NOTHING;
