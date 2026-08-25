DROP TRIGGER IF EXISTS "ledger_event_wallet_version" ON "ledger_event";
DROP FUNCTION IF EXISTS app.bump_wallet_version_on_published_event();
