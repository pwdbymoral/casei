-- Partial settlements are append-only deltas and may repeat for one transaction.
DROP INDEX "ledger_event_transaction_type_unique";
CREATE UNIQUE INDEX "ledger_event_transaction_type_unique"
  ON "ledger_event" ("transaction_id", "event_type")
  WHERE "transaction_id" IS NOT NULL
    AND "event_type" <> 'transaction.partially_settled.v1';
