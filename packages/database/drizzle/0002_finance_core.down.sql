DROP TABLE IF EXISTS "card_payment", "credit_statement", "credit_card", "installment", "installment_plan", "recurrence_occurrence", "recurrence_rule", "finance_transaction", "ledger_entry", "ledger_event", "finance_category", "financial_account" CASCADE;
DROP FUNCTION IF EXISTS app.guard_published_ledger_entry();
DROP FUNCTION IF EXISTS app.guard_published_ledger_event();
DROP FUNCTION IF EXISTS app.assert_ledger_entry_event_balanced();
DROP FUNCTION IF EXISTS app.assert_published_event_balanced();
