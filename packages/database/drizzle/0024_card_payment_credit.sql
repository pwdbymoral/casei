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
  "remaining_minor" bigint NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "canceled_at" timestamptz,
  CONSTRAINT "card_credit_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "card_credit_remaining_check" CHECK ("remaining_minor" >= 0 AND "remaining_minor" <= "amount_minor"),
  CONSTRAINT "card_credit_state_check" CHECK ("state" in ('active', 'consumed', 'canceled')),
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

CREATE TABLE "card_credit_application" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "credit_id" uuid NOT NULL REFERENCES "card_credit"("id") ON DELETE RESTRICT,
  "statement_id" uuid NOT NULL REFERENCES "credit_statement"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "reversed_at" timestamptz,
  CONSTRAINT "card_credit_application_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "card_credit_application_state_check" CHECK ("state" in ('active', 'reversed')),
  CONSTRAINT "card_credit_application_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "card_credit_application_credit_workspace_fk"
    FOREIGN KEY ("workspace_id", "credit_id")
    REFERENCES "card_credit" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "card_credit_application_statement_workspace_fk"
    FOREIGN KEY ("workspace_id", "statement_id")
    REFERENCES "credit_statement" ("workspace_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "card_credit_application_statement_idx"
  ON "card_credit_application" ("workspace_id", "statement_id", "state", "created_at");

-- Repair the historical first-purchase double increment deterministically from
-- immutable purchase/adjustment rows before allocating legacy payments.
WITH expected AS (
  SELECT s.id,
         COALESCE((SELECT sum(t.amount_minor)
                     FROM finance_transaction t
                    WHERE t.workspace_id = s.workspace_id
                      AND t.statement_id = s.id
                      AND t.instrument = 'card'
                      AND t.kind = 'expense'
                      AND t.state <> 'canceled'), 0)
         + COALESCE((SELECT sum(a.amount_minor)
                       FROM card_statement_adjustment a
                      WHERE a.workspace_id = s.workspace_id
                        AND a.statement_id = s.id), 0) AS total_minor
    FROM credit_statement s
)
UPDATE credit_statement s
   SET total_minor = expected.total_minor
  FROM expected
 WHERE expected.id = s.id
   AND s.total_minor <> expected.total_minor;

-- Reconcile legacy payments in creation order: only the amount still open is
-- applied and every excess becomes an explicit credit source.
UPDATE card_payment p
   SET applied_minor = GREATEST(
     LEAST(
       p.amount_minor,
       GREATEST(
         s.total_minor - COALESCE((SELECT sum(previous.amount_minor)
                                    FROM card_payment previous
                                   WHERE previous.statement_id = p.statement_id
                                     AND (previous.created_at, previous.id) < (p.created_at, p.id)), 0),
         0
       )
     ),
     0
   )
  FROM credit_statement s
 WHERE s.id = p.statement_id;

INSERT INTO card_credit (workspace_id, card_id, payment_id, amount_minor, remaining_minor)
SELECT p.workspace_id, s.card_id, p.id, p.amount_minor - p.applied_minor,
       p.amount_minor - p.applied_minor
  FROM card_payment p
  JOIN credit_statement s ON s.workspace_id = p.workspace_id AND s.id = p.statement_id
 WHERE p.amount_minor > p.applied_minor;

UPDATE credit_statement s
   SET paid_minor = COALESCE((SELECT sum(p.applied_minor)
                                FROM card_payment p
                               WHERE p.workspace_id = s.workspace_id
                                 AND p.statement_id = s.id), 0),
       state = CASE
         WHEN COALESCE((SELECT sum(p.applied_minor) FROM card_payment p
                         WHERE p.workspace_id = s.workspace_id AND p.statement_id = s.id), 0) >= s.total_minor
              AND (s.total_minor > 0 OR s.state IN ('paid', 'partially_paid')) THEN 'paid'
         WHEN COALESCE((SELECT sum(p.applied_minor) FROM card_payment p
                         WHERE p.workspace_id = s.workspace_id AND p.statement_id = s.id), 0) > 0 THEN 'partially_paid'
         WHEN s.state = 'open' THEN 'open'
         ELSE 'closed'
       END;

GRANT SELECT, INSERT, UPDATE, DELETE ON "card_credit", "card_credit_application" TO casei_app;
ALTER TABLE "card_credit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_credit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "card_credit_scope" ON "card_credit"
  USING ("workspace_id" = app.current_workspace_id())
  WITH CHECK ("workspace_id" = app.current_workspace_id());
ALTER TABLE "card_credit_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_credit_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY "card_credit_application_scope" ON "card_credit_application"
  USING ("workspace_id" = app.current_workspace_id())
  WITH CHECK ("workspace_id" = app.current_workspace_id());
