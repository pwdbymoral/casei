import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("persiste excedente de pagamento como crédito reversível", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0024_card_payment_credit.sql", import.meta.url)),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN "applied_minor" bigint/i);
  assert.match(migration, /CREATE TABLE "card_credit"/i);
  assert.match(migration, /REFERENCES "card_payment"\("id"\)/i);
  assert.match(migration, /"state" in \('active', 'consumed', 'canceled'\)/i);
  assert.match(migration, /CREATE TABLE "card_credit_application"/i);
  assert.match(migration, /card_statement_adjustment/i);
  assert.match(migration, /GREATEST\([\s\S]*applied_minor/i);
  assert.match(migration, /CREATE POLICY "card_credit_scope"/i);
  assert.match(migration, /UPDATE "card_payment"[\s\S]*SET "applied_minor" = "amount_minor"/i);
});
