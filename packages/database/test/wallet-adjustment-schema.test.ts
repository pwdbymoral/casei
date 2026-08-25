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
