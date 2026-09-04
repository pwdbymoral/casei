DROP TABLE IF EXISTS "card_credit_application" CASCADE;
DROP TABLE IF EXISTS "card_credit" CASCADE;
DROP INDEX IF EXISTS "card_payment_workspace_id_id_unique";
ALTER TABLE "card_payment"
  DROP CONSTRAINT IF EXISTS "card_payment_applied_check";
ALTER TABLE "card_payment"
  DROP COLUMN IF EXISTS "applied_minor";
