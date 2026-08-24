ALTER TABLE "finance_transaction" DROP CONSTRAINT IF EXISTS "finance_transaction_goal_scope_fk";
DROP INDEX IF EXISTS "finance_transaction_goal_idx";
ALTER TABLE "finance_transaction" DROP COLUMN IF EXISTS "goal_id";
DROP TABLE IF EXISTS "goal_reservation_movement" CASCADE;
DROP TABLE IF EXISTS "goal" CASCADE;
DROP FUNCTION IF EXISTS app.guard_goal_reservation_immutable();
