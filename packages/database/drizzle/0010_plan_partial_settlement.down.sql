-- Never delete or merge historical deltas to fit the old uniqueness invariant.
-- A rollback is intentionally blocked when repeated partial settlements exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM ledger_event
     WHERE transaction_id IS NOT NULL
       AND event_type = 'transaction.partially_settled.v1'
     GROUP BY transaction_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot rollback 0010_plan_partial_settlement: multiple partial settlements exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "ledger_event_transaction_type_unique";
CREATE UNIQUE INDEX "ledger_event_transaction_type_unique"
  ON "ledger_event" ("transaction_id", "event_type")
  WHERE "transaction_id" IS NOT NULL;
