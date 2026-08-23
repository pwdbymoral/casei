CREATE TABLE "financial_account" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "financial_account_kind_check" CHECK ("kind" in ('wallet', 'card_liability', 'income', 'expense', 'adjustment', 'loan_receivable', 'loan_payable')),
  CONSTRAINT "financial_account_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "financial_account_workspace_id_id_currency_unique" UNIQUE ("workspace_id", "id", "currency_code"),
  CONSTRAINT "financial_account_workspace_kind_name_unique" UNIQUE ("workspace_id", "kind", "name")
);

CREATE TABLE "finance_category" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "finance_category_kind_check" CHECK ("kind" in ('income', 'expense', 'both')),
  CONSTRAINT "finance_category_workspace_id_id_unique" UNIQUE ("workspace_id", "id")
);
CREATE UNIQUE INDEX "finance_category_active_name_unique" ON "finance_category" ("workspace_id", lower("name")) WHERE "archived" = false;

CREATE TABLE "ledger_event" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "transaction_id" uuid,
  "event_type" text NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "occurred_on" date NOT NULL,
  "published_at" timestamptz,
  "reversed_event_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ledger_event_status_check" CHECK ("status" in ('draft', 'published', 'reversed')),
  CONSTRAINT "ledger_event_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ledger_event_workspace_id_id_currency_unique" UNIQUE ("workspace_id", "id", "currency_code")
);
CREATE UNIQUE INDEX "ledger_event_transaction_type_unique" ON "ledger_event" ("transaction_id", "event_type") WHERE "transaction_id" IS NOT NULL;

CREATE TABLE "ledger_entry" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "amount_minor" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ledger_entry_amount_nonzero_check" CHECK ("amount_minor" <> 0),
  CONSTRAINT "ledger_entry_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ledger_entry_event_account_unique" UNIQUE ("event_id", "account_id"),
  CONSTRAINT "ledger_entry_event_fk" FOREIGN KEY ("workspace_id", "event_id", "currency_code") REFERENCES "ledger_event" ("workspace_id", "id", "currency_code") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_account_fk" FOREIGN KEY ("workspace_id", "account_id", "currency_code") REFERENCES "financial_account" ("workspace_id", "id", "currency_code") ON DELETE RESTRICT
);

CREATE TABLE "finance_transaction" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "state" text DEFAULT 'planned' NOT NULL,
  "instrument" text DEFAULT 'wallet' NOT NULL,
  "amount_minor" bigint NOT NULL,
  "settled_minor" bigint DEFAULT 0 NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "occurred_on" date NOT NULL,
  "due_on" date,
  "posted_on" timestamptz,
  "cash_settled_on" timestamptz,
  "description" text DEFAULT '' NOT NULL,
  "category_id" uuid,
  "card_id" uuid,
  "statement_id" uuid,
  "recurrence_id" uuid,
  "installment_plan_id" uuid,
  "installment_number" integer,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "finance_transaction_kind_check" CHECK ("kind" in ('income', 'expense', 'transfer', 'adjustment')),
  CONSTRAINT "finance_transaction_state_check" CHECK ("state" in ('planned', 'partially_settled', 'posted', 'canceled')),
  CONSTRAINT "finance_transaction_instrument_check" CHECK ("instrument" in ('wallet', 'card')),
  CONSTRAINT "finance_transaction_amount_check" CHECK ("amount_minor" > 0 AND "settled_minor" >= 0 AND "settled_minor" <= "amount_minor"),
  CONSTRAINT "finance_transaction_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "finance_transaction_workspace_id_id_unique" UNIQUE ("workspace_id", "id")
);
ALTER TABLE "finance_transaction" ADD CONSTRAINT "finance_transaction_category_fk" FOREIGN KEY ("workspace_id", "category_id") REFERENCES "finance_category" ("workspace_id", "id") ON DELETE RESTRICT;

CREATE TABLE "recurrence_rule" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "frequency" text NOT NULL,
  "interval" integer DEFAULT 1 NOT NULL,
  "start_on" date NOT NULL,
  "end_on" date,
  "max_occurrences" integer,
  "variable" boolean DEFAULT false NOT NULL,
  "estimated_minor" bigint,
  "paused_on" date,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "recurrence_frequency_check" CHECK ("frequency" in ('weekly', 'monthly', 'annual')),
  CONSTRAINT "recurrence_interval_check" CHECK ("interval" > 0)
);

CREATE TABLE "recurrence_occurrence" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "recurrence_id" uuid NOT NULL REFERENCES "recurrence_rule"("id") ON DELETE RESTRICT,
  "transaction_id" uuid NOT NULL REFERENCES "finance_transaction"("id") ON DELETE RESTRICT,
  "occurrence_on" date NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "recurrence_occurrence_natural_unique" UNIQUE ("recurrence_id", "occurrence_on")
);

CREATE TABLE "installment_plan" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "total_minor" bigint NOT NULL,
  "count" integer NOT NULL,
  "first_due_on" date NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "installment_plan_total_check" CHECK ("total_minor" > 0),
  CONSTRAINT "installment_plan_count_check" CHECK ("count" between 2 and 999)
);

CREATE TABLE "installment" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "plan_id" uuid NOT NULL REFERENCES "installment_plan"("id") ON DELETE RESTRICT,
  "transaction_id" uuid NOT NULL REFERENCES "finance_transaction"("id") ON DELETE RESTRICT,
  "number" integer NOT NULL,
  "amount_minor" bigint NOT NULL,
  "due_on" date NOT NULL,
  CONSTRAINT "installment_plan_number_unique" UNIQUE ("plan_id", "number"),
  CONSTRAINT "installment_number_check" CHECK ("number" > 0),
  CONSTRAINT "installment_amount_check" CHECK ("amount_minor" > 0)
);

CREATE TABLE "credit_card" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "closing_day" smallint NOT NULL,
  "due_day" smallint NOT NULL,
  "holder" text,
  "last_four" varchar(4),
  "limit_minor" bigint,
  "currency_code" varchar(3) NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "credit_card_closing_day_check" CHECK ("closing_day" between 1 and 31),
  CONSTRAINT "credit_card_due_day_check" CHECK ("due_day" between 1 and 31),
  CONSTRAINT "credit_card_last_four_check" CHECK ("last_four" is null or "last_four" ~ '^[0-9]{4}$'),
  CONSTRAINT "credit_card_limit_check" CHECK ("limit_minor" is null or "limit_minor" >= 0),
  CONSTRAINT "credit_card_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "credit_card_workspace_id_id_unique" UNIQUE ("workspace_id", "id")
);

CREATE TABLE "credit_statement" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "card_id" uuid NOT NULL REFERENCES "credit_card"("id") ON DELETE RESTRICT,
  "period_start" date NOT NULL,
  "closing_on" date NOT NULL,
  "due_on" date NOT NULL,
  "state" text DEFAULT 'open' NOT NULL,
  "total_minor" bigint DEFAULT 0 NOT NULL,
  "paid_minor" bigint DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "credit_statement_card_closing_unique" UNIQUE ("card_id", "closing_on"),
  CONSTRAINT "credit_statement_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "credit_statement_state_check" CHECK ("state" in ('open', 'closed', 'partially_paid', 'paid', 'canceled')),
  CONSTRAINT "credit_statement_amount_check" CHECK ("total_minor" >= 0 AND "paid_minor" >= 0)
);
ALTER TABLE "credit_statement" ADD CONSTRAINT "credit_statement_card_workspace_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "credit_card" ("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "finance_transaction" ADD CONSTRAINT "finance_transaction_card_workspace_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "credit_card" ("workspace_id", "id") ON DELETE RESTRICT;
ALTER TABLE "finance_transaction" ADD CONSTRAINT "finance_transaction_statement_workspace_fk" FOREIGN KEY ("workspace_id", "statement_id") REFERENCES "credit_statement" ("workspace_id", "id") ON DELETE RESTRICT;

CREATE TABLE "card_payment" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "statement_id" uuid NOT NULL REFERENCES "credit_statement"("id") ON DELETE RESTRICT,
  "transaction_id" uuid NOT NULL REFERENCES "finance_transaction"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "card_payment_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "card_payment_transaction_unique" UNIQUE ("transaction_id")
);
ALTER TABLE "card_payment" ADD CONSTRAINT "card_payment_statement_workspace_fk" FOREIGN KEY ("workspace_id", "statement_id") REFERENCES "credit_statement" ("workspace_id", "id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION app.assert_ledger_entry_event_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count integer; total bigint; event_status text; target_event uuid;
BEGIN
  target_event := COALESCE(NEW.event_id, OLD.event_id);
  SELECT status INTO event_status FROM ledger_event WHERE id = target_event;
  IF event_status <> 'published' THEN RETURN NULL; END IF;
  SELECT count(*)::integer, coalesce(sum(amount_minor), 0) INTO entry_count, total FROM ledger_entry WHERE event_id = target_event;
  IF entry_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'published ledger event must have at least two balanced entries';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_event_balance_on_entry
AFTER INSERT OR UPDATE OR DELETE ON ledger_entry
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_ledger_entry_event_balanced();
CREATE OR REPLACE FUNCTION app.assert_published_event_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count integer; total bigint;
BEGIN
  IF NEW.status <> 'published' THEN RETURN NULL; END IF;
  SELECT count(*)::integer, coalesce(sum(amount_minor), 0) INTO entry_count, total FROM ledger_entry WHERE event_id = NEW.id;
  IF entry_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'published ledger event must have at least two balanced entries';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_event_balance_on_publish
AFTER UPDATE OF status ON ledger_event
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_published_event_balanced();

CREATE OR REPLACE FUNCTION app.guard_published_ledger_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' AND (TG_OP = 'DELETE' OR NEW.status <> 'reversed' OR NEW.workspace_id <> OLD.workspace_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id OR NEW.event_type <> OLD.event_type OR NEW.currency_code <> OLD.currency_code OR NEW.occurred_on <> OLD.occurred_on) THEN
    RAISE EXCEPTION 'published ledger event is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_event_immutable_guard BEFORE UPDATE OR DELETE ON ledger_event FOR EACH ROW EXECUTE FUNCTION app.guard_published_ledger_event();

CREATE OR REPLACE FUNCTION app.guard_published_ledger_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_event WHERE id = COALESCE(OLD.event_id, NEW.event_id) AND status = 'published') THEN
    RAISE EXCEPTION 'published ledger entries are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entry_immutable_guard BEFORE UPDATE OR DELETE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION app.guard_published_ledger_entry();

GRANT SELECT, INSERT, UPDATE, DELETE ON financial_account, finance_category, ledger_event, ledger_entry, finance_transaction, recurrence_rule, recurrence_occurrence, installment_plan, installment, credit_card, credit_statement, card_payment TO casei_app;
ALTER TABLE financial_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_account FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_category FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_event FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE recurrence_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurrence_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE recurrence_occurrence ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurrence_occurrence FORCE ROW LEVEL SECURITY;
ALTER TABLE installment_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_plan FORCE ROW LEVEL SECURITY;
ALTER TABLE installment ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_statement FORCE ROW LEVEL SECURITY;
ALTER TABLE card_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_payment FORCE ROW LEVEL SECURITY;

CREATE POLICY financial_account_scope ON financial_account USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY finance_category_scope ON finance_category USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY ledger_event_scope ON ledger_event USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY ledger_entry_scope ON ledger_entry USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY finance_transaction_scope ON finance_transaction USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY recurrence_rule_scope ON recurrence_rule USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY recurrence_occurrence_scope ON recurrence_occurrence USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY installment_plan_scope ON installment_plan USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY installment_scope ON installment USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY credit_card_scope ON credit_card USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY credit_statement_scope ON credit_statement USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY card_payment_scope ON card_payment USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
