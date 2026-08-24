DROP TRIGGER IF EXISTS shopping_item_event_immutable_guard ON shopping_item_event;
DROP FUNCTION IF EXISTS app.guard_shopping_item_event_immutable();
DROP TABLE IF EXISTS shopping_item_event;
DROP TABLE IF EXISTS shopping_item;
ALTER TABLE "stock_product" DROP COLUMN IF EXISTS "shopping_auto";
