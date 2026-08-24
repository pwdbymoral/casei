DROP INDEX IF EXISTS "shopping_item_expense_transaction_idx";
ALTER TABLE "shopping_item"
  DROP CONSTRAINT IF EXISTS "shopping_item_expense_transaction_scope_fk";
ALTER TABLE "shopping_item"
  DROP COLUMN IF EXISTS "expense_transaction_id";
