-- Persist the rule's source values so future job expansion does not depend on
-- whichever occurrence happened to be materialized first.
ALTER TABLE "recurrence_rule"
  ADD COLUMN "kind" text,
  ADD COLUMN "amount_minor" bigint,
  ADD COLUMN "description" text DEFAULT '';

UPDATE "recurrence_rule" AS r
   SET "kind" = source.kind,
       "amount_minor" = source.amount_minor,
       "description" = source.description
  FROM (
    SELECT DISTINCT ON (t.recurrence_id)
           t.recurrence_id, t.kind, t.amount_minor, t.description
      FROM "finance_transaction" AS t
     WHERE t.recurrence_id IS NOT NULL
     ORDER BY t.recurrence_id, t.occurred_on ASC, t.created_at ASC, t.id ASC
  ) AS source
 WHERE r.id = source.recurrence_id;

ALTER TABLE "recurrence_rule"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "amount_minor" SET NOT NULL,
  ALTER COLUMN "description" SET NOT NULL;
ALTER TABLE "recurrence_rule"
  ADD CONSTRAINT "recurrence_kind_check" CHECK ("kind" in ('income', 'expense')),
  ADD CONSTRAINT "recurrence_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "recurrence_date_order_check" CHECK ("end_on" IS NULL OR "end_on" >= "start_on");

-- A recurrence occurrence is backed by exactly one planned transaction for
-- its civil date. This natural key makes retries/concurrent workers harmless.
CREATE UNIQUE INDEX "finance_transaction_recurrence_date_unique"
  ON "finance_transaction" ("workspace_id", "recurrence_id", "occurred_on")
  WHERE "recurrence_id" IS NOT NULL;

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
