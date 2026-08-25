CREATE TABLE "card_statement_adjustment" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "statement_id" uuid NOT NULL,
  "transaction_id" uuid NOT NULL,
  "source_transaction_id" uuid,
  "kind" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "description" text NOT NULL,
  "occurred_on" date NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "card_statement_adjustment_kind_check" CHECK ("kind" in ('charge', 'fee', 'interest', 'refund')),
  CONSTRAINT "card_statement_adjustment_amount_check" CHECK (
    ("kind" = 'refund' AND "amount_minor" < 0)
    OR ("kind" <> 'refund' AND "amount_minor" > 0)
  ),
  CONSTRAINT "card_statement_adjustment_refund_source_check" CHECK (
    ("kind" = 'refund' AND "source_transaction_id" IS NOT NULL)
    OR ("kind" <> 'refund' AND "source_transaction_id" IS NULL)
  ),
  CONSTRAINT "card_statement_adjustment_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "card_statement_adjustment_transaction_unique" UNIQUE ("transaction_id"),
  CONSTRAINT "card_statement_adjustment_statement_workspace_fk"
    FOREIGN KEY ("workspace_id", "statement_id")
    REFERENCES "credit_statement" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "card_statement_adjustment_transaction_workspace_fk"
    FOREIGN KEY ("workspace_id", "transaction_id")
    REFERENCES "finance_transaction" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "card_statement_adjustment_source_workspace_fk"
    FOREIGN KEY ("workspace_id", "source_transaction_id")
    REFERENCES "finance_transaction" ("workspace_id", "id") ON DELETE RESTRICT
 );

CREATE INDEX "card_statement_adjustment_statement_occurred_idx"
  ON "card_statement_adjustment" ("workspace_id", "statement_id", "occurred_on", "id");
CREATE INDEX "card_statement_adjustment_source_idx"
  ON "card_statement_adjustment" ("workspace_id", "source_transaction_id")
  WHERE "source_transaction_id" IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON card_statement_adjustment TO casei_app;
ALTER TABLE card_statement_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_statement_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY card_statement_adjustment_scope ON card_statement_adjustment
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
