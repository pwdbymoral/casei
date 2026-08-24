import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("GOAL-001/002 migration persists scoped goals and append-only reserve movements", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0011_goals.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );
  const schema = await readFile(
    fileURLToPath(new URL("../src/schema.ts", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE "goal"/i);
  assert.match(migration, /CREATE TABLE "goal_reservation_movement"/i);
  assert.match(migration, /ALTER TABLE "finance_transaction" ADD COLUMN "goal_id"/i);
  assert.match(migration, /goal_reservation_movement_kind_check/i);
  assert.match(migration, /guard_goal_reservation_immutable/i);
  assert.match(migration, /transaction/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(journal, /"idx": 11[\s\S]*"tag": "0011_goals"/i);
  assert.match(schema, /export const goal = pgTable\(/i);
  assert.match(schema, /export const goalReservationMovement = pgTable\(/i);
  assert.match(schema, /goalId: uuid\("goal_id"\)/i);
});
