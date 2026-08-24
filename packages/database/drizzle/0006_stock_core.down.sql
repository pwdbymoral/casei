DROP TRIGGER IF EXISTS stock_movement_immutable_guard ON stock_movement;
DROP FUNCTION IF EXISTS app.guard_stock_movement_immutable();
DROP TABLE IF EXISTS stock_movement;
DROP TABLE IF EXISTS stock_product;
