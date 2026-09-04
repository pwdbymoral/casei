ALTER TABLE "card_payment"
  ADD COLUMN "applied_minor" bigint;

UPDATE "card_payment"
   SET "applied_minor" = "amount_minor";

ALTER TABLE "card_payment"
  ALTER COLUMN "applied_minor" SET NOT NULL;

ALTER TABLE "card_payment"
  ADD CONSTRAINT "card_payment_applied_check"
  CHECK ("applied_minor" >= 0 AND "applied_minor" <= "amount_minor");

CREATE UNIQUE INDEX "card_payment_workspace_id_id_unique"
  ON "card_payment" ("workspace_id", "id");

CREATE TABLE "card_credit" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "card_id" uuid NOT NULL REFERENCES "credit_card"("id") ON DELETE RESTRICT,
  "payment_id" uuid NOT NULL REFERENCES "card_payment"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "canceled_at" timestamptz,
  CONSTRAINT "card_credit_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "card_credit_state_check" CHECK ("state" in ('active', 'canceled')),
  CONSTRAINT "card_credit_payment_unique" UNIQUE ("payment_id"),
  CONSTRAINT "card_credit_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "card_credit_card_workspace_fk"
    FOREIGN KEY ("workspace_id", "card_id")
    REFERENCES "credit_card" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "card_credit_payment_workspace_fk"
    FOREIGN KEY ("workspace_id", "payment_id")
    REFERENCES "card_payment" ("workspace_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "card_credit_card_state_idx"
  ON "card_credit" ("workspace_id", "card_id", "state", "created_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON "card_credit" TO casei_app;
ALTER TABLE "card_credit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_credit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "card_credit_scope" ON "card_credit"
  USING ("workspace_id" = app.current_workspace_id())
  WITH CHECK ("workspace_id" = app.current_workspace_id());
