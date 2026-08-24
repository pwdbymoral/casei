CREATE TABLE "stock_product" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "name_normalized" text NOT NULL,
  "unit" text DEFAULT 'unit' NOT NULL,
  "unit_label" text,
  "quantity_milli" bigint,
  "minimum_milli" bigint,
  "marked_missing" boolean DEFAULT false NOT NULL,
  "category" text,
  "location" text,
  "note" text,
  "archived" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "stock_product_workspace_id_id_unique" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "stock_product_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "stock_product_unit_check" CHECK ("unit" in ('unit', 'package', 'box', 'kg', 'g', 'L', 'ml', 'other')),
  CONSTRAINT "stock_product_other_unit_label_check" CHECK ("unit" <> 'other' or ("unit_label" is not null and length(trim("unit_label")) > 0)),
  CONSTRAINT "stock_product_quantity_check" CHECK ("quantity_milli" is null or ("quantity_milli" >= 0 and "quantity_milli" <= 999999999999999)),
  CONSTRAINT "stock_product_minimum_check" CHECK ("minimum_milli" is null or ("minimum_milli" >= 0 and "minimum_milli" <= 999999999999999)),
  CONSTRAINT "stock_product_version_check" CHECK ("version" >= 0)
);
CREATE UNIQUE INDEX "stock_product_active_name_unique"
  ON "stock_product" ("workspace_id", "name_normalized")
  WHERE "archived" = false;
CREATE INDEX "stock_product_active_search_idx"
  ON "stock_product" ("workspace_id", "archived", "name_normalized");

CREATE TABLE "stock_movement" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "quantity_milli" bigint NOT NULL,
  "before_milli" bigint,
  "after_milli" bigint,
  "reason" text,
  "author_id" text NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "stock_movement_product_scope_fk"
    FOREIGN KEY ("workspace_id", "product_id") REFERENCES "stock_product"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "stock_movement_author_fk"
    FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "stock_movement_kind_check" CHECK ("kind" in ('entry', 'consume', 'correction', 'discard')),
  CONSTRAINT "stock_movement_quantity_check" CHECK ("quantity_milli" >= 0 and "quantity_milli" <= 999999999999999),
  CONSTRAINT "stock_movement_before_check" CHECK ("before_milli" is null or ("before_milli" >= 0 and "before_milli" <= 999999999999999)),
  CONSTRAINT "stock_movement_after_check" CHECK ("after_milli" is null or ("after_milli" >= 0 and "after_milli" <= 999999999999999))
);
CREATE INDEX "stock_movement_product_occurred_idx"
  ON "stock_movement" ("workspace_id", "product_id", "occurred_at", "id");

CREATE OR REPLACE FUNCTION app.guard_stock_movement_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movements are append-only';
END;
$$;
CREATE TRIGGER stock_movement_immutable_guard
  BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_movement_immutable();

-- The baseline migration grants DML on all public tables. Revoke that inherited
-- access before granting the smallest stock command surface explicitly.
REVOKE INSERT, UPDATE, DELETE ON stock_product FROM casei_app;
REVOKE INSERT, UPDATE, DELETE ON stock_movement FROM casei_app;
GRANT SELECT, INSERT, UPDATE ON stock_product TO casei_app;
GRANT SELECT, INSERT ON stock_movement TO casei_app;
ALTER TABLE stock_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_product FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_product_scope ON stock_product
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY stock_movement_scope ON stock_movement
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
