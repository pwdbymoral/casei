ALTER TABLE "stock_movement"
  DROP CONSTRAINT "stock_movement_product_scope_fk";
ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_product_scope_fk"
  FOREIGN KEY ("workspace_id", "product_id")
  REFERENCES "stock_product"("workspace_id", "id") ON DELETE CASCADE;

ALTER TABLE "shopping_item"
  DROP CONSTRAINT "shopping_item_product_scope_fk";
ALTER TABLE "shopping_item"
  ADD CONSTRAINT "shopping_item_product_scope_fk"
  FOREIGN KEY ("workspace_id", "product_id")
  REFERENCES "stock_product"("workspace_id", "id") ON DELETE CASCADE;

ALTER TABLE "shopping_item_event"
  DROP CONSTRAINT "shopping_item_event_item_scope_fk";
ALTER TABLE "shopping_item_event"
  ADD CONSTRAINT "shopping_item_event_item_scope_fk"
  FOREIGN KEY ("workspace_id", "item_id")
  REFERENCES "shopping_item"("workspace_id", "id") ON DELETE CASCADE;
