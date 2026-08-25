import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("wallet version migration ignores draft ledger entries", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0017_wallet_adjustment.sql", import.meta.url)),
    "utf8",
  );

  assert.match(
    migration,
    /AND EXISTS \(\s+SELECT 1\s+FROM "ledger_event" published_event\s+WHERE published_event\."workspace_id" = NEW\."workspace_id"\s+AND published_event\."id" = NEW\."event_id"\s+AND published_event\."status" = 'published'\s+\)/,
  );
  assert.match(
    migration,
    /JOIN "ledger_event" published_event\s+ON published_event\."workspace_id" = entry\."workspace_id"\s+AND published_event\."id" = entry\."event_id"\s+AND published_event\."status" = 'published'/,
  );
});

test("wallet version hardening handles draft publication and published-entry retries", async () => {
  const migration = await readFile(
    fileURLToPath(new URL("../drizzle/0018_wallet_publish_version.sql", import.meta.url)),
    "utf8",
  );
  const down = await readFile(
    fileURLToPath(new URL("../drizzle/0018_wallet_publish_version.down.sql", import.meta.url)),
    "utf8",
  );
  const journal = await readFile(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION app\.bump_wallet_version_on_published_event/i,
  );
  assert.match(migration, /count\s*\(\*\)::integer AS entry_count/i);
  assert.match(migration, /CREATE TRIGGER "ledger_event_wallet_version"/i);
  assert.match(migration, /AFTER UPDATE OF status ON "ledger_event"/i);
  assert.match(migration, /NEW\.status\s*=\s*'published'/i);
  assert.match(migration, /entry\.event_id\s*=\s*NEW\.id/i);
  assert.match(migration, /entry\.account_id/i);
  assert.match(down, /DROP TRIGGER IF EXISTS "ledger_event_wallet_version"/i);
  assert.match(journal, /"idx": 18[\s\S]*"tag": "0018_wallet_publish_version"/i);
});
