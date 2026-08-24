DROP INDEX IF EXISTS "ledger_event_transaction_type_unique";
CREATE UNIQUE INDEX "ledger_event_transaction_type_unique"
  ON "ledger_event" ("transaction_id", "event_type")
  WHERE "transaction_id" IS NOT NULL;
