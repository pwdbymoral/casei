-- Loan ledger references are part of the historical identity of a contract or
-- payment. They may only be created by the domain command, never retargeted.
CREATE OR REPLACE FUNCTION app.guard_loan_contract_event_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.principal_event_id IS DISTINCT FROM NEW.principal_event_id
     OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
     OR OLD.direction IS DISTINCT FROM NEW.direction THEN
    RAISE EXCEPTION 'loan contract ledger reference is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loan_contract_event_reference_guard
BEFORE UPDATE ON "loan_contract"
FOR EACH ROW EXECUTE FUNCTION app.guard_loan_contract_event_reference();

CREATE OR REPLACE FUNCTION app.guard_loan_payment_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.loan_id IS DISTINCT FROM NEW.loan_id
     OR OLD.ledger_event_id IS DISTINCT FROM NEW.ledger_event_id
     OR OLD.currency_code IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION 'loan payment ledger reference is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loan_payment_reference_guard
BEFORE UPDATE ON "loan_payment"
FOR EACH ROW EXECUTE FUNCTION app.guard_loan_payment_reference();

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

  -- Do not let a malformed or retargeted reference turn this lifecycle command
  -- into a delete of an unrelated ledger event. The composite FKs enforce the
  -- workspace/currency relation; these predicates enforce the event semantics.
  IF EXISTS (
    SELECT 1
      FROM "loan_contract" lc
      LEFT JOIN "ledger_event" ev
        ON ev.workspace_id = lc.workspace_id
       AND ev.id = lc.principal_event_id
       AND ev.currency_code = lc.currency_code
     WHERE lc.workspace_id = candidate
       AND (
         ev.id IS NULL
         OR ev.workspace_id IS DISTINCT FROM candidate
         OR ev.event_type NOT LIKE 'loan.%'
         OR ev.transaction_id IS NOT NULL
       )
  ) OR EXISTS (
    SELECT 1
      FROM "loan_payment" lp
      LEFT JOIN "ledger_event" ev
        ON ev.workspace_id = lp.workspace_id
       AND ev.id = lp.ledger_event_id
       AND ev.currency_code = lp.currency_code
     WHERE lp.workspace_id = candidate
       AND (
         ev.id IS NULL
         OR ev.workspace_id IS DISTINCT FROM candidate
         OR ev.event_type NOT LIKE 'loan.%'
         OR ev.transaction_id IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'workspace loan purge found an invalid ledger reference' USING ERRCODE = '23514';
  END IF;

  ALTER TABLE "ledger_entry" DISABLE TRIGGER "ledger_entry_immutable_guard";
  ALTER TABLE "ledger_entry" DISABLE TRIGGER "ledger_event_balance_on_entry";
  ALTER TABLE "ledger_event" DISABLE TRIGGER "ledger_event_immutable_guard";

  DELETE FROM "ledger_entry"
   WHERE "workspace_id" = candidate
     AND "event_id" IN (
       SELECT ev.id
         FROM "loan_contract" lc
         JOIN "ledger_event" ev
           ON ev.workspace_id = lc.workspace_id
          AND ev.id = lc.principal_event_id
          AND ev.currency_code = lc.currency_code
        WHERE lc.workspace_id = candidate
          AND ev.event_type LIKE 'loan.%'
          AND ev.transaction_id IS NULL
       UNION
       SELECT ev.id
         FROM "loan_payment" lp
         JOIN "ledger_event" ev
           ON ev.workspace_id = lp.workspace_id
          AND ev.id = lp.ledger_event_id
          AND ev.currency_code = lp.currency_code
        WHERE lp.workspace_id = candidate
          AND ev.event_type LIKE 'loan.%'
          AND ev.transaction_id IS NULL
     );
  GET DIAGNOSTICS removed_entries = ROW_COUNT;

  DELETE FROM "ledger_event"
   WHERE "workspace_id" = candidate
     AND "event_type" LIKE 'loan.%'
     AND "transaction_id" IS NULL
     AND "id" IN (
       SELECT lc.principal_event_id FROM "loan_contract" lc WHERE lc.workspace_id = candidate
       UNION
       SELECT lp.ledger_event_id FROM "loan_payment" lp WHERE lp.workspace_id = candidate
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
