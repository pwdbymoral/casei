CREATE TABLE "goal" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "target_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "deadline" date,
  "priority" text DEFAULT 'normal' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "note" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "goal_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "goal_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "goal_target_check" CHECK ("target_minor" > 0),
  CONSTRAINT "goal_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "goal_priority_check" CHECK ("priority" in ('low', 'normal', 'high')),
  CONSTRAINT "goal_status_check" CHECK ("status" in ('active', 'completed', 'paused', 'canceled')),
  CONSTRAINT "goal_version_check" CHECK ("version" >= 0),
  CONSTRAINT "goal_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE
);
CREATE INDEX "goal_workspace_status_idx" ON "goal" ("workspace_id", "status", "deadline", "id");

CREATE TABLE "goal_reservation_movement" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "goal_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "transaction_id" uuid,
  "occurred_on" date NOT NULL,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "goal_reservation_movement_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "goal_reservation_movement_goal_scope_fk"
    FOREIGN KEY ("workspace_id", "goal_id") REFERENCES "goal"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "goal_reservation_movement_transaction_scope_fk"
    FOREIGN KEY ("workspace_id", "transaction_id") REFERENCES "finance_transaction"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "goal_reservation_movement_kind_check" CHECK ("kind" in ('allocate', 'release', 'spend')),
  CONSTRAINT "goal_reservation_movement_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "goal_reservation_movement_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "goal_reservation_movement_transaction_check" CHECK (("kind" = 'spend' AND "transaction_id" IS NOT NULL) OR ("kind" <> 'spend' AND "transaction_id" IS NULL))
);
CREATE INDEX "goal_reservation_movement_goal_occurred_idx"
  ON "goal_reservation_movement" ("workspace_id", "goal_id", "occurred_on", "created_at", "id");
CREATE UNIQUE INDEX "goal_reservation_movement_spend_transaction_unique"
  ON "goal_reservation_movement" ("transaction_id") WHERE "kind" = 'spend';

ALTER TABLE "finance_transaction" ADD COLUMN "goal_id" uuid;
ALTER TABLE "finance_transaction" ADD CONSTRAINT "finance_transaction_goal_scope_fk"
  FOREIGN KEY ("workspace_id", "goal_id") REFERENCES "goal"("workspace_id", "id") ON DELETE RESTRICT;
CREATE INDEX "finance_transaction_goal_idx" ON "finance_transaction" ("workspace_id", "goal_id", "occurred_on", "id");

CREATE OR REPLACE FUNCTION app.guard_goal_reservation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'goal reservation movements are append-only';
END;
$$;
CREATE TRIGGER goal_reservation_immutable_guard
  BEFORE UPDATE OR DELETE ON "goal_reservation_movement"
  FOR EACH ROW EXECUTE FUNCTION app.guard_goal_reservation_immutable();

-- Workspace deletion is the one authorized lifecycle operation that removes
-- the append-only goal history. Keep it behind a SECURITY DEFINER function so
-- the application role cannot delete movements directly or bypass the guard.
CREATE OR REPLACE FUNCTION app.purge_workspace_goals(candidate uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  removed_movements integer := 0;
  removed_goals integer := 0;
BEGIN
  IF candidate IS DISTINCT FROM app.current_workspace_id() THEN
    RAISE EXCEPTION 'workspace purge scope mismatch' USING ERRCODE = '42501';
  END IF;

  -- Remove the reverse reference before deleting goals; regular goal spends
  -- retain their finance transaction until the workspace cascade runs.
  UPDATE finance_transaction
     SET goal_id = NULL
   WHERE workspace_id = candidate AND goal_id IS NOT NULL;

  -- The trigger remains active for every normal command. Only this owner-run
  -- lifecycle function temporarily disables it inside the same transaction.
  ALTER TABLE goal_reservation_movement DISABLE TRIGGER goal_reservation_immutable_guard;
  DELETE FROM goal_reservation_movement WHERE workspace_id = candidate;
  GET DIAGNOSTICS removed_movements = ROW_COUNT;
  ALTER TABLE goal_reservation_movement ENABLE TRIGGER goal_reservation_immutable_guard;

  DELETE FROM goal WHERE workspace_id = candidate;
  GET DIAGNOSTICS removed_goals = ROW_COUNT;
  RETURN removed_movements + removed_goals;
EXCEPTION WHEN OTHERS THEN
  -- The surrounding transaction also rolls back DDL, but restore explicitly
  -- so the trigger cannot remain disabled if the function is reused.
  ALTER TABLE goal_reservation_movement ENABLE TRIGGER goal_reservation_immutable_guard;
  RAISE;
END;
$$;
GRANT EXECUTE ON FUNCTION app.purge_workspace_goals(uuid) TO casei_app;

GRANT SELECT, INSERT, UPDATE ON "goal" TO casei_app;
GRANT SELECT, INSERT ON "goal_reservation_movement" TO casei_app;
ALTER TABLE "goal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goal" FORCE ROW LEVEL SECURITY;
ALTER TABLE "goal_reservation_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goal_reservation_movement" FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_workspace_scope ON "goal"
  USING ("workspace_id" = app.current_workspace_id())
  WITH CHECK ("workspace_id" = app.current_workspace_id());
CREATE POLICY goal_reservation_movement_scope ON "goal_reservation_movement"
  USING ("workspace_id" = app.current_workspace_id())
  WITH CHECK ("workspace_id" = app.current_workspace_id());
