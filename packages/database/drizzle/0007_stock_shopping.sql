ALTER TABLE "stock_product"
  ADD COLUMN "shopping_auto" boolean NOT NULL DEFAULT true;

CREATE TABLE "shopping_item" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "product_id" uuid,
  "name" text NOT NULL,
  "name_normalized" text NOT NULL,
  "source" text NOT NULL,
  "quantity_milli" bigint,
  "unit" text DEFAULT 'unit' NOT NULL,
  "unit_label" text,
  "note" text,
  "purchased" boolean DEFAULT false NOT NULL,
  "purchased_at" timestamptz,
  "purchased_by" text REFERENCES "user"("id") ON DELETE RESTRICT,
  "last_changed_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "shopping_item_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "shopping_item_product_scope_fk"
    FOREIGN KEY ("workspace_id", "product_id") REFERENCES "stock_product"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shopping_item_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "shopping_item_source_check" CHECK ("source" in ('automatic', 'free')),
  CONSTRAINT "shopping_item_unit_check" CHECK ("unit" in ('unit', 'package', 'box', 'kg', 'g', 'L', 'ml', 'other')),
  CONSTRAINT "shopping_item_other_unit_label_check" CHECK ("unit" <> 'other' or ("unit_label" is not null and length(trim("unit_label")) > 0)),
  CONSTRAINT "shopping_item_quantity_check" CHECK ("quantity_milli" is null or ("quantity_milli" >= 0 and "quantity_milli" <= 999999999999999)),
  CONSTRAINT "shopping_item_source_product_check" CHECK (("source" = 'automatic' and "product_id" is not null) or ("source" = 'free' and "product_id" is null)),
  CONSTRAINT "shopping_item_purchased_check" CHECK (("purchased" = false and "purchased_at" is null) or ("purchased" = true and "purchased_at" is not null)),
  CONSTRAINT "shopping_item_version_check" CHECK ("version" >= 0)
);
CREATE UNIQUE INDEX "shopping_item_active_name_unique"
  ON "shopping_item" ("workspace_id", "name_normalized")
  WHERE "purchased" = false;
CREATE INDEX "shopping_item_active_order_idx"
  ON "shopping_item" ("workspace_id", "purchased", "updated_at", "id");

CREATE TABLE "shopping_item_event" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "actor_id" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "shopping_item_event_item_scope_fk"
    FOREIGN KEY ("workspace_id", "item_id") REFERENCES "shopping_item"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "shopping_item_event_kind_check" CHECK ("kind" in ('created', 'purchased'))
);
CREATE INDEX "shopping_item_event_item_occurred_idx"
  ON "shopping_item_event" ("workspace_id", "item_id", "occurred_at", "id");

CREATE OR REPLACE FUNCTION app.guard_shopping_item_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shopping item events are append-only';
END;
$$;
CREATE TRIGGER shopping_item_event_immutable_guard
  BEFORE UPDATE OR DELETE ON shopping_item_event
  FOR EACH ROW EXECUTE FUNCTION app.guard_shopping_item_event_immutable();

-- The baseline migration grants DML on every public table. Revoke destructive
-- access before granting the smallest command surface for the append-only log.
REVOKE DELETE ON shopping_item FROM casei_app;
REVOKE UPDATE, DELETE ON shopping_item_event FROM casei_app;
GRANT SELECT, INSERT, UPDATE ON shopping_item TO casei_app;
GRANT SELECT, INSERT ON shopping_item_event TO casei_app;
ALTER TABLE shopping_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_item FORCE ROW LEVEL SECURITY;
ALTER TABLE shopping_item_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_item_event FORCE ROW LEVEL SECURITY;
CREATE POLICY shopping_item_scope ON shopping_item
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY shopping_item_event_scope ON shopping_item_event
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
