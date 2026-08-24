CREATE TABLE "loan_contract" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "counterparty" text NOT NULL,
  "principal_minor" bigint NOT NULL,
  "paid_minor" bigint DEFAULT 0 NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "occurred_on" date NOT NULL,
  "due_on" date,
  "principal_event_id" uuid NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loan_contract_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "loan_contract_direction_check" CHECK ("direction" in ('lent', 'borrowed')),
  CONSTRAINT "loan_contract_counterparty_check" CHECK (length(trim("counterparty")) between 1 and 200),
  CONSTRAINT "loan_contract_principal_check" CHECK ("principal_minor" > 0 AND "paid_minor" >= 0 AND "paid_minor" <= "principal_minor"),
  CONSTRAINT "loan_contract_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "loan_contract_date_order_check" CHECK ("due_on" IS NULL OR "due_on" >= "occurred_on"),
  CONSTRAINT "loan_contract_status_check" CHECK ("status" in ('open', 'settled')),
  CONSTRAINT "loan_contract_status_amount_check" CHECK (("status" = 'open' AND "paid_minor" < "principal_minor") OR ("status" = 'settled' AND "paid_minor" = "principal_minor")),
  CONSTRAINT "loan_contract_version_check" CHECK ("version" >= 0),
  CONSTRAINT "loan_contract_principal_event_fk" FOREIGN KEY ("workspace_id", "principal_event_id", "currency_code")
    REFERENCES "ledger_event" ("workspace_id", "id", "currency_code") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE "loan_payment" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "loan_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL,
  "occurred_on" date NOT NULL,
  "ledger_event_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loan_payment_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "loan_payment_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "loan_payment_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "loan_payment_loan_fk" FOREIGN KEY ("workspace_id", "loan_id")
    REFERENCES "loan_contract" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "loan_payment_event_fk" FOREIGN KEY ("workspace_id", "ledger_event_id", "currency_code")
    REFERENCES "ledger_event" ("workspace_id", "id", "currency_code") ON DELETE RESTRICT,
  CONSTRAINT "loan_payment_event_unique" UNIQUE ("workspace_id", "ledger_event_id")
);

CREATE INDEX "loan_contract_workspace_status_due_idx"
  ON "loan_contract" ("workspace_id", "status", "due_on", "occurred_on", "id");

GRANT SELECT, INSERT, UPDATE, DELETE ON "loan_contract", "loan_payment" TO casei_app;
ALTER TABLE "loan_contract" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loan_contract" FORCE ROW LEVEL SECURITY;
ALTER TABLE "loan_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loan_payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "loan_contract_scope" ON "loan_contract"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
CREATE POLICY "loan_payment_scope" ON "loan_payment"
  USING (workspace_id = "app"."current_workspace_id"())
  WITH CHECK (workspace_id = "app"."current_workspace_id"());
