-- A completed shopping item may point to the existing expense that paid for
-- it. The API validates kind/workspace/state before writing this reference;
-- the composite FK keeps the reference scoped to the same workspace.
ALTER TABLE "shopping_item"
  ADD COLUMN "expense_transaction_id" uuid;

ALTER TABLE "shopping_item"
  ADD CONSTRAINT "shopping_item_expense_transaction_scope_fk"
  FOREIGN KEY ("workspace_id", "expense_transaction_id")
  REFERENCES "finance_transaction"("workspace_id", "id") ON DELETE RESTRICT;

CREATE INDEX "shopping_item_expense_transaction_idx"
  ON "shopping_item" ("workspace_id", "expense_transaction_id")
  WHERE "expense_transaction_id" IS NOT NULL;
