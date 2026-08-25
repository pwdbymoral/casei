DROP TRIGGER IF EXISTS "ledger_entry_wallet_version" ON "ledger_entry";
DROP FUNCTION IF EXISTS "app"."bump_wallet_version_on_ledger_entry"();
ALTER TABLE "workspace_preference"
  DROP CONSTRAINT IF EXISTS "workspace_preference_initial_balance_transaction_fk";
ALTER TABLE "workspace_preference"
  DROP COLUMN IF EXISTS "initial_balance_transaction_id",
  DROP COLUMN IF EXISTS "initial_balance_materialized_at";
