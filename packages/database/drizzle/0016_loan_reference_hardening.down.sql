DROP TRIGGER IF EXISTS loan_payment_reference_guard ON "loan_payment";
DROP FUNCTION IF EXISTS app.guard_loan_payment_reference();
DROP TRIGGER IF EXISTS loan_contract_event_reference_guard ON "loan_contract";
DROP FUNCTION IF EXISTS app.guard_loan_contract_event_reference();

-- Restore the 0015 purge semantics while keeping its authorized scope and
-- trigger handling when this hardening migration is rolled back.
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
