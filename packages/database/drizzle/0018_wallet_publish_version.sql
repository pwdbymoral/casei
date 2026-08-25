-- A wallet entry can be created while its ledger event is draft and the event
-- can be published only after all balanced entries exist. The original 0017
-- entry trigger therefore missed that publication path. Keep the 0017 behavior
-- for an event inserted as published (one increment per wallet entry), and
-- count only this event's wallet entries when draft becomes published.
CREATE OR REPLACE FUNCTION app.bump_wallet_version_on_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE financial_account
     SET version = version + 1,
         updated_at = now()
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.account_id
     AND kind = 'wallet'
     AND EXISTS (
       SELECT 1
         FROM ledger_event published_event
        WHERE published_event.workspace_id = NEW.workspace_id
          AND published_event.id = NEW.event_id
          AND published_event.status = 'published'
     );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bump_wallet_version_on_published_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'published' THEN
    UPDATE financial_account account
       SET version = version + source.entry_count,
           updated_at = now()
      FROM (
        SELECT entry.workspace_id,
               entry.account_id,
               count(*)::integer AS entry_count
          FROM ledger_entry entry
         WHERE entry.workspace_id = NEW.workspace_id
           AND entry.event_id = NEW.id
         GROUP BY entry.workspace_id, entry.account_id
      ) source
     WHERE account.workspace_id = source.workspace_id
       AND account.id = source.account_id
       AND account.kind = 'wallet';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ledger_event_wallet_version"
AFTER UPDATE OF status ON "ledger_event"
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'published')
EXECUTE FUNCTION app.bump_wallet_version_on_published_event();
