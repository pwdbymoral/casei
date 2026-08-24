import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("migration de estoque preserva histórico, RLS e invariantes de quantidade", async () => {
  const sql = await readFile(
    fileURLToPath(new URL("../drizzle/0006_stock_core.sql", import.meta.url)),
    "utf8",
  );
  const down = await readFile(
    fileURLToPath(new URL("../drizzle/0006_stock_core.down.sql", import.meta.url)),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "stock_product"/);
  assert.match(sql, /stock_product_active_name_unique/);
  assert.match(sql, /WHERE "archived" = false/);
  assert.match(sql, /"quantity_milli" >= 0/);
  assert.match(sql, /"unit_label" is not null and length\(trim\("unit_label"\)\) > 0/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /stock_movement_immutable_guard/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON stock_product/);
  assert.doesNotMatch(sql, /GRANT .*DELETE ON stock_product/);
  assert.match(down, /DROP TABLE IF EXISTS stock_movement/);
  assert.match(down, /DROP TABLE IF EXISTS stock_product/);
});
