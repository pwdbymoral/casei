-- Loan history is purged only as part of the authorized workspace lifecycle.
-- The application role cannot remove ledger or payment history directly.
ALTER TABLE "loan_contract"
  DROP CONSTRAINT "loan_contract_principal_event_fk";
ALTER TABLE "loan_contract"
  ADD CONSTRAINT "loan_contract_principal_event_fk"
  FOREIGN KEY ("workspace_id", "principal_event_id", "currency_code")
  REFERENCES "ledger_event" ("workspace_id", "id", "currency_code")
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "loan_payment"
  DROP CONSTRAINT "loan_payment_loan_fk";
ALTER TABLE "loan_payment"
  ADD CONSTRAINT "loan_payment_loan_fk"
  FOREIGN KEY ("workspace_id", "loan_id")
  REFERENCES "loan_contract" ("workspace_id", "id")
  ON DELETE CASCADE;

ALTER TABLE "loan_payment"
  DROP CONSTRAINT "loan_payment_event_fk";
ALTER TABLE "loan_payment"
  ADD CONSTRAINT "loan_payment_event_fk"
  FOREIGN KEY ("workspace_id", "ledger_event_id", "currency_code")
  REFERENCES "ledger_event" ("workspace_id", "id", "currency_code")
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION app.purge_workspace_loans(candidate uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  removed_entries integer := 0;
  removed_events integer := 0;
BEGIN
  IF candidate IS DISTINCT FROM app.current_workspace_id() THEN
    RAISE EXCEPTION 'workspace loan purge scope mismatch' USING ERRCODE = '42501';
  END IF;

  -- Published ledger rows are immutable during normal operation. The owner-run
  -- lifecycle function disables only those guards for the exact loan events it
  -- selected, removes entries before events, and restores the guards on every
  -- path. Audit events remain detached by the caller and are not deleted here.
  ALTER TABLE "ledger_entry" DISABLE TRIGGER "ledger_entry_immutable_guard";
  ALTER TABLE "ledger_entry" DISABLE TRIGGER "ledger_event_balance_on_entry";
  ALTER TABLE "ledger_event" DISABLE TRIGGER "ledger_event_immutable_guard";

  DELETE FROM "ledger_entry"
   WHERE "workspace_id" = candidate
     AND "event_id" IN (
       SELECT "principal_event_id" FROM "loan_contract" WHERE "workspace_id" = candidate
       UNION
       SELECT "ledger_event_id" FROM "loan_payment" WHERE "workspace_id" = candidate
     );
  GET DIAGNOSTICS removed_entries = ROW_COUNT;

  DELETE FROM "ledger_event"
   WHERE "workspace_id" = candidate
     AND "id" IN (
       SELECT "principal_event_id" FROM "loan_contract" WHERE "workspace_id" = candidate
       UNION
       SELECT "ledger_event_id" FROM "loan_payment" WHERE "workspace_id" = candidate
     );
  GET DIAGNOSTICS removed_events = ROW_COUNT;

  ALTER TABLE "ledger_event" ENABLE TRIGGER "ledger_event_immutable_guard";
  ALTER TABLE "ledger_entry" ENABLE TRIGGER "ledger_event_balance_on_entry";
  ALTER TABLE "ledger_entry" ENABLE TRIGGER "ledger_entry_immutable_guard";
  RETURN removed_entries + removed_events;
EXCEPTION WHEN OTHERS THEN
  ALTER TABLE "ledger_event" ENABLE TRIGGER "ledger_event_immutable_guard";
  ALTER TABLE "ledger_entry" ENABLE TRIGGER "ledger_event_balance_on_entry";
  ALTER TABLE "ledger_entry" ENABLE TRIGGER "ledger_entry_immutable_guard";
  RAISE;
END;
$$;

REVOKE UPDATE, DELETE ON TABLE "ledger_event", "ledger_entry" FROM casei_app;
REVOKE UPDATE, DELETE ON TABLE "loan_payment" FROM casei_app;
REVOKE DELETE ON TABLE "loan_contract" FROM casei_app;
GRANT EXECUTE ON FUNCTION app.purge_workspace_loans(uuid) TO casei_app;
