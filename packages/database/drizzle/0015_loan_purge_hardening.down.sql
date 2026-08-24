REVOKE EXECUTE ON FUNCTION app.purge_workspace_loans(uuid) FROM casei_app;
DROP FUNCTION IF EXISTS app.purge_workspace_loans(uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ledger_event", "ledger_entry" TO casei_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "loan_payment", "loan_contract" TO casei_app;

ALTER TABLE "loan_payment"
  DROP CONSTRAINT "loan_payment_event_fk";
ALTER TABLE "loan_payment"
  ADD CONSTRAINT "loan_payment_event_fk"
  FOREIGN KEY ("workspace_id", "ledger_event_id", "currency_code")
  REFERENCES "ledger_event" ("workspace_id", "id", "currency_code")
  ON DELETE RESTRICT;

ALTER TABLE "loan_payment"
  DROP CONSTRAINT "loan_payment_loan_fk";
ALTER TABLE "loan_payment"
  ADD CONSTRAINT "loan_payment_loan_fk"
  FOREIGN KEY ("workspace_id", "loan_id")
  REFERENCES "loan_contract" ("workspace_id", "id")
  ON DELETE RESTRICT;

ALTER TABLE "loan_contract"
  DROP CONSTRAINT "loan_contract_principal_event_fk";
ALTER TABLE "loan_contract"
  ADD CONSTRAINT "loan_contract_principal_event_fk"
  FOREIGN KEY ("workspace_id", "principal_event_id", "currency_code")
  REFERENCES "ledger_event" ("workspace_id", "id", "currency_code")
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
