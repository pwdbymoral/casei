ALTER TABLE "workspace_preference"
  ADD COLUMN "initial_balance_materialized_at" timestamp with time zone,
  ADD COLUMN "initial_balance_transaction_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspace_preference"
  ADD CONSTRAINT "workspace_preference_initial_balance_transaction_fk"
  FOREIGN KEY ("workspace_id", "initial_balance_transaction_id")
  REFERENCES "finance_transaction" ("workspace_id", "id") ON DELETE restrict;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."bump_wallet_version_on_ledger_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "financial_account"
     SET "version" = "version" + 1,
         "updated_at" = now()
   WHERE "workspace_id" = NEW."workspace_id"
     AND "id" = NEW."account_id"
     AND "kind" = 'wallet';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_entry_wallet_version"
AFTER INSERT ON "ledger_entry"
FOR EACH ROW EXECUTE FUNCTION "app"."bump_wallet_version_on_ledger_entry"();
--> statement-breakpoint
UPDATE "financial_account" account
   SET "version" = source.entry_count,
       "updated_at" = now()
  FROM (
    SELECT entry."workspace_id", entry."account_id", count(*)::integer AS entry_count
      FROM "ledger_entry" entry
      JOIN "financial_account" wallet
        ON wallet."workspace_id" = entry."workspace_id"
       AND wallet."id" = entry."account_id"
       AND wallet."kind" = 'wallet'
     GROUP BY entry."workspace_id", entry."account_id"
  ) source
 WHERE account."workspace_id" = source."workspace_id"
   AND account."id" = source."account_id";
