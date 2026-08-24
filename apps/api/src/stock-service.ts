import {
  type CreateStockProductInput,
  type CreateStockShoppingItemInput,
  createStockMovementSchema,
  createStockProductSchema,
  createStockShoppingItemSchema,
  markStockMissingSchema,
  purchaseStockShoppingItemSchema,
  stockProductListQuerySchema,
  stockShoppingListQuerySchema,
  type UpdateStockProductInput,
  updateStockProductSchema,
} from "@casei/contracts";
import type { Pool, PoolClient } from "@casei/database";
import { executeIdempotent, type JsonValue, withUnitOfWork } from "@casei/database";
import {
  deriveStockState,
  formatStockQuantity,
  normalizeProductName,
  parseStockQuantity,
  stockMovementAfter,
  suggestedShoppingQuantity,
} from "@casei/domain";

export interface StockScope {
  workspaceId: string;
  actorId: string;
  correlationId: string;
  role: "owner" | "member" | "viewer";
}

export interface StockProductView {
  id: string;
  workspaceId: string;
  name: string;
  unit: "unit" | "package" | "box" | "kg" | "g" | "L" | "ml" | "other";
  unitLabel: string | null;
  quantity: string | null;
  minimum: string | null;
  markedMissing: boolean;
  shoppingAuto: boolean;
  state: "unknown" | "ok" | "low" | "missing";
  category: string | null;
  location: string | null;
  note: string | null;
  archived: boolean;
  version: number;
}

export interface StockMovementView {
  id: string;
  workspaceId: string;
  productId: string;
  kind: "entry" | "consume" | "correction" | "discard";
  quantity: string;
  before: string | null;
  after: string | null;
  reason: string | null;
  authorId: string;
  occurredAt: string;
}

export interface StockShoppingItemView {
  id: string;
  workspaceId: string;
  productId: string | null;
  name: string;
  source: "automatic" | "free";
  quantity: string | null;
  unit: StockProductView["unit"];
  unitLabel: string | null;
  note: string | null;
  purchased: boolean;
  purchasedAt: string | null;
  lastChangedBy: string;
  version: number;
}

export class StockNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("Produto não encontrado.");
    this.name = "StockNotFoundError";
  }
}

export class StockPermissionError extends Error {
  readonly code = "permission_denied" as const;
  constructor() {
    super("Você não tem permissão para alterar o estoque.");
    this.name = "StockPermissionError";
  }
}

export class StockConflictError extends Error {
  readonly code = "conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "StockConflictError";
  }
}

export class StockVersionConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor(readonly currentVersion: number) {
    super("O produto foi alterado. Revise e tente novamente.");
    this.name = "StockVersionConflictError";
  }
}

interface StockProductRow {
  id: string;
  workspace_id: string;
  name: string;
  unit: StockProductView["unit"];
  unit_label: string | null;
  quantity_milli: bigint | string | null;
  minimum_milli: bigint | string | null;
  marked_missing: boolean;
  shopping_auto: boolean;
  category: string | null;
  location: string | null;
  note: string | null;
  archived: boolean;
  version: number;
}

interface StockMovementRow {
  id: string;
  workspace_id: string;
  product_id: string;
  kind: StockMovementView["kind"];
  quantity_milli: bigint | string;
  before_milli: bigint | string | null;
  after_milli: bigint | string | null;
  reason: string | null;
  author_id: string;
  occurred_at: Date | string;
}

interface ShoppingItemRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  name: string;
  source: StockShoppingItemView["source"];
  quantity_milli: bigint | string | null;
  effective_quantity_milli: bigint | string | null;
  unit: StockProductView["unit"];
  unit_label: string | null;
  note: string | null;
  purchased: boolean;
  purchased_at: Date | string | null;
  last_changed_by: string;
  version: number;
}

export class StockService {
  private readonly applicationRole: string;

  constructor(
    private readonly pool: Pool,
    options: { applicationRole?: string } = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
  }

  async createProduct(
    scope: StockScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; product: StockProductView }> {
    const parsed = createStockProductSchema.parse(input);
    const normalized = normalizeProductName(parsed.name);
    if (!normalized.display) throw new StockConflictError("O nome do produto é obrigatório.");
    const values = normalizeStockInput(parsed);
    const result = await this.withUnitOfWork(
      scope,
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/products`,
          key: idempotencyKey,
          request: parsed,
          execute: async () => {
            let product: StockProductView;
            try {
              const result = await client.query<StockProductRow>(
                `INSERT INTO stock_product
                (workspace_id, name, name_normalized, unit, unit_label, quantity_milli,
                 minimum_milli, shopping_auto, category, location, note)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING id, workspace_id, name, unit, unit_label, quantity_milli,
                         minimum_milli, marked_missing, shopping_auto, category, location, note, archived, version`,
                [
                  scope.workspaceId,
                  normalized.display,
                  normalized.key,
                  values.unit,
                  values.unitLabel,
                  values.quantityMilli,
                  values.minimumMilli,
                  values.shoppingAuto,
                  values.category,
                  values.location,
                  values.note,
                ],
              );
              const row = result.rows[0];
              if (!row) throw new Error("Produto não foi criado.");
              product = toProductView(row);
              if (values.quantityMilli !== null) {
                await client.query(
                  `INSERT INTO stock_movement
                  (workspace_id, product_id, kind, quantity_milli, before_milli, after_milli, author_id)
                 VALUES ($1, $2, 'entry', $3, NULL, $3, $4)`,
                  [scope.workspaceId, row.id, values.quantityMilli, scope.actorId],
                );
              }
              await syncAutomaticShoppingItems(client, scope);
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw new StockConflictError("Já existe um produto ativo com esse nome.");
              }
              throw error;
            }
            return { statusCode: 201, response: product as unknown as JsonValue };
          },
        }),
      "write",
    );
    return { replayed: result.replayed, product: result.response as unknown as StockProductView };
  }

  async listProducts(
    scope: StockScope,
    query: { query?: string; includeArchived?: boolean; limit?: number } = {},
  ): Promise<StockProductView[]> {
    const parsed = stockProductListQuerySchema.parse(query);
    const search = parsed.query ? `%${normalizeProductName(parsed.query).key}%` : null;
    return this.withUnitOfWork(scope, async ({ client }) => {
      const result = await client.query<StockProductRow>(
        `SELECT id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                marked_missing, shopping_auto, category, location, note, archived, version
           FROM stock_product
          WHERE workspace_id = $1
            AND ($2::boolean OR archived = false)
            AND ($3::text IS NULL OR name_normalized LIKE $3)
          ORDER BY archived ASC,
                   CASE WHEN marked_missing OR quantity_milli = 0 THEN 0
                        WHEN minimum_milli IS NOT NULL AND quantity_milli <= minimum_milli THEN 1
                        ELSE 2 END,
                   lower(name), id
          LIMIT $4`,
        [scope.workspaceId, parsed.includeArchived, search, parsed.limit],
      );
      return result.rows.map(toProductView);
    });
  }

  async getProduct(scope: StockScope, productId: string): Promise<StockProductView | null> {
    return this.withUnitOfWork(scope, async ({ client }) => {
      const result = await client.query<StockProductRow>(
        `SELECT id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                marked_missing, shopping_auto, category, location, note, archived, version
           FROM stock_product WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, productId],
      );
      return result.rows[0] ? toProductView(result.rows[0]) : null;
    });
  }

  async updateProduct(
    scope: StockScope,
    productId: string,
    input: unknown,
    expectedVersion: number,
  ): Promise<StockProductView> {
    const parsed = updateStockProductSchema.parse(input);
    const normalized = normalizeProductName(parsed.name);
    const values = normalizeUpdateInput(parsed);
    return this.withUnitOfWork(
      scope,
      async ({ client }) => {
        const current = await lockProduct(client, scope, productId);
        assertExpectedVersion(current.version, expectedVersion);
        if (current.unit !== values.unit) {
          const movement = await client.query<{ id: string }>(
            "SELECT id FROM stock_movement WHERE workspace_id = $1 AND product_id = $2 LIMIT 1",
            [scope.workspaceId, productId],
          );
          if (movement.rowCount) {
            throw new StockConflictError("A unidade não pode mudar depois do primeiro movimento.");
          }
        }
        try {
          const result = await client.query<StockProductRow>(
            `UPDATE stock_product
              SET name = $3, name_normalized = $4, unit = $5, unit_label = $6,
                  minimum_milli = $7, shopping_auto = $11, category = $8, location = $9, note = $10,
                  version = version + 1, updated_at = now()
            WHERE workspace_id = $1 AND id = $2 AND version = $12
            RETURNING id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                      marked_missing, shopping_auto, category, location, note, archived, version`,
            [
              scope.workspaceId,
              productId,
              normalized.display,
              normalized.key,
              values.unit,
              values.unitLabel,
              values.minimumMilli,
              values.category,
              values.location,
              values.note,
              values.shoppingAuto,
              expectedVersion,
            ],
          );
          const row = result.rows[0];
          if (!row) throw new StockVersionConflictError(current.version);
          await syncAutomaticShoppingItems(client, scope);
          return toProductView(row);
        } catch (error) {
          if (isUniqueViolation(error))
            throw new StockConflictError("Já existe um produto ativo com esse nome.");
          throw error;
        }
      },
      "write",
    );
  }

  async setArchived(
    scope: StockScope,
    productId: string,
    archived: boolean,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; product: StockProductView }> {
    const result = await this.withUnitOfWork(
      scope,
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/products/${productId}/${archived ? "archive" : "restore"}`,
          key: idempotencyKey,
          request: { productId, archived, expectedVersion },
          execute: async () => {
            const current = await lockProduct(client, scope, productId);
            assertExpectedVersion(current.version, expectedVersion);
            if (!archived) {
              const collision = await client.query<{ id: string }>(
                `SELECT id FROM stock_product
                WHERE workspace_id = $1 AND name_normalized = $2 AND archived = false AND id <> $3
                LIMIT 1`,
                [
                  scope.workspaceId,
                  current.name
                    .trim()
                    .replace(/\s+/gu, " ")
                    .normalize("NFD")
                    .replace(/\p{Diacritic}/gu, "")
                    .toLocaleLowerCase("pt-BR"),
                  productId,
                ],
              );
              if (collision.rowCount)
                throw new StockConflictError("Já existe um produto ativo com esse nome.");
            }
            let updated: { rows: StockProductRow[] };
            try {
              updated = await client.query<StockProductRow>(
                `UPDATE stock_product SET archived = $3, version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND id = $2 AND version = $4
                RETURNING id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                          marked_missing, shopping_auto, category, location, note, archived, version`,
                [scope.workspaceId, productId, archived, expectedVersion],
              );
            } catch (error) {
              if (isUniqueViolation(error))
                throw new StockConflictError("Já existe um produto ativo com esse nome.");
              throw error;
            }
            const row = updated.rows[0];
            if (!row) throw new StockVersionConflictError(current.version);
            await syncAutomaticShoppingItems(client, scope);
            return { statusCode: 200, response: toProductView(row) as unknown as JsonValue };
          },
        }),
      "write",
    );
    return { replayed: result.replayed, product: result.response as unknown as StockProductView };
  }

  async createMovement(
    scope: StockScope,
    productId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; product: StockProductView; movement: StockMovementView }> {
    const parsed = createStockMovementSchema.parse(input);
    if (
      parsed.kind !== "correction" &&
      parseStockQuantity(parsed.quantity, { allowZero: true }) === 0n
    ) {
      throw new StockConflictError("A quantidade precisa ser maior que zero.");
    }
    const result = await this.withUnitOfWork(
      scope,
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/products/${productId}/movements`,
          key: idempotencyKey,
          request: { productId, ...parsed, expectedVersion },
          execute: async () => {
            const current = await lockProduct(client, scope, productId);
            assertExpectedVersion(current.version, expectedVersion);
            if (current.archived)
              throw new StockConflictError("Produto arquivado não aceita movimentações.");
            const quantityMilli = parseStockQuantity(parsed.quantity, {
              allowZero: parsed.kind === "correction",
            });
            if (
              current.quantity_milli === null &&
              parsed.kind !== "entry" &&
              parsed.kind !== "correction"
            ) {
              throw new StockConflictError("Defina uma quantidade antes de consumir ou descartar.");
            }
            const afterMilli = stockMovementAfter({
              kind: parsed.kind,
              beforeMilli: normalizeStockValue(current.quantity_milli),
              quantityMilli,
            });
            const movementResult = await client.query<StockMovementRow>(
              `INSERT INTO stock_movement
              (workspace_id, product_id, kind, quantity_milli, before_milli, after_milli, reason, author_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, workspace_id, product_id, kind, quantity_milli, before_milli,
                       after_milli, reason, author_id, occurred_at`,
              [
                scope.workspaceId,
                productId,
                parsed.kind,
                quantityMilli,
                normalizeStockValue(current.quantity_milli),
                afterMilli,
                parsed.reason ?? null,
                scope.actorId,
              ],
            );
            const movementRow = movementResult.rows[0];
            if (!movementRow) throw new Error("Movimentação não foi criada.");
            const productResult = await client.query<StockProductRow>(
              `UPDATE stock_product SET quantity_milli = $3, marked_missing = false,
                version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $4
              RETURNING id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                        marked_missing, shopping_auto, category, location, note, archived, version`,
              [scope.workspaceId, productId, afterMilli, expectedVersion],
            );
            const productRow = productResult.rows[0];
            if (!productRow) throw new StockVersionConflictError(current.version);
            await syncAutomaticShoppingItems(client, scope);
            return {
              statusCode: 201,
              response: {
                product: toProductView(productRow),
                movement: toMovementView(movementRow),
              } as unknown as JsonValue,
            };
          },
        }),
      "write",
    );
    const response = result.response as unknown as {
      product: StockProductView;
      movement: StockMovementView;
    };
    return { replayed: result.replayed, ...response };
  }

  async markMissing(
    scope: StockScope,
    productId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{ replayed: boolean; product: StockProductView }> {
    const parsed = markStockMissingSchema.parse(input);
    const result = await this.withUnitOfWork(
      scope,
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/products/${productId}/missing`,
          key: idempotencyKey,
          request: { productId, ...parsed, expectedVersion },
          execute: async () => {
            const current = await lockProduct(client, scope, productId);
            assertExpectedVersion(current.version, expectedVersion);
            const updated = await client.query<StockProductRow>(
              `UPDATE stock_product SET marked_missing = $3, version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $4
              RETURNING id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                        marked_missing, shopping_auto, category, location, note, archived, version`,
              [scope.workspaceId, productId, parsed.missing, expectedVersion],
            );
            const row = updated.rows[0];
            if (!row) throw new StockVersionConflictError(current.version);
            await syncAutomaticShoppingItems(client, scope);
            return { statusCode: 200, response: toProductView(row) as unknown as JsonValue };
          },
        }),
      "write",
    );
    return { replayed: result.replayed, product: result.response as unknown as StockProductView };
  }

  async listShoppingItems(
    scope: StockScope,
    query: { includePurchased?: boolean; limit?: number } = {},
  ): Promise<StockShoppingItemView[]> {
    const parsed = stockShoppingListQuerySchema.parse(query);
    return this.withUnitOfWork(scope, async ({ client }) => {
      const result = await client.query<ShoppingItemRow>(
        `SELECT i.id, i.workspace_id, i.product_id, i.name, i.source,
                i.quantity_milli,
                CASE WHEN p.id IS NULL THEN i.quantity_milli
                     WHEN p.minimum_milli IS NULL THEN NULL
                     ELSE GREATEST(p.minimum_milli - COALESCE(p.quantity_milli, 0), 0)
                END AS effective_quantity_milli,
                COALESCE(p.unit, i.unit) AS unit,
                COALESCE(p.unit_label, i.unit_label) AS unit_label,
                i.note, i.purchased, i.purchased_at, i.last_changed_by, i.version
           FROM shopping_item i
           LEFT JOIN stock_product p
             ON p.workspace_id = i.workspace_id AND p.id = i.product_id
          WHERE i.workspace_id = $1
            AND ($2::boolean OR i.purchased = false)
            AND (i.purchased OR ((i.source = 'free' AND NOT EXISTS (
                   SELECT 1 FROM stock_product duplicate
                    WHERE duplicate.workspace_id = i.workspace_id
                      AND duplicate.name_normalized = i.name_normalized
                      AND duplicate.archived = false
                 )) OR (i.source = 'automatic' AND p.id IS NOT NULL
                 AND p.shopping_auto = true
                 AND (p.marked_missing OR p.quantity_milli = 0
                      OR (p.quantity_milli IS NOT NULL AND p.minimum_milli IS NOT NULL
                          AND p.quantity_milli <= p.minimum_milli)))))
          ORDER BY i.purchased ASC, i.source ASC, lower(i.name), i.id
          LIMIT $3`,
        [scope.workspaceId, parsed.includePurchased, parsed.limit],
      );
      return result.rows.map(toShoppingItemView);
    });
  }

  async createShoppingItem(
    scope: StockScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; deduplicated: boolean; item: StockShoppingItemView }> {
    assertStockCapability(scope);
    const parsed = createStockShoppingItemSchema.parse(input);
    const normalized = normalizeProductName(parsed.name);
    const values = normalizeShoppingInput(parsed);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/shopping`,
        key: idempotencyKey,
        request: parsed,
        execute: async () => {
          const existing = await findActiveShoppingItem(client, scope, normalized.key);
          if (existing) {
            return {
              statusCode: 200,
              response: {
                deduplicated: true,
                item: toShoppingItemView(existing),
              } as unknown as JsonValue,
            };
          }
          const product = await client.query<{ id: string }>(
            `SELECT id FROM stock_product
              WHERE workspace_id = $1 AND name_normalized = $2 AND archived = false
              LIMIT 1`,
            [scope.workspaceId, normalized.key],
          );
          if (product.rowCount)
            throw new StockConflictError(
              "Esse nome já existe no estoque; use a entrada automática.",
            );
          const inserted = await client.query<ShoppingItemRow>(
            `INSERT INTO shopping_item
              (workspace_id, name, name_normalized, source, quantity_milli, unit, unit_label, note,
               last_changed_by)
             VALUES ($1, $2, $3, 'free', $4, $5, $6, $7, $8)
             ON CONFLICT (workspace_id, name_normalized) WHERE purchased = false DO NOTHING
             RETURNING id, workspace_id, product_id, name, source, quantity_milli,
                       quantity_milli AS effective_quantity_milli, unit, unit_label, note,
                       purchased, purchased_at, last_changed_by, version`,
            [
              scope.workspaceId,
              normalized.display,
              normalized.key,
              values.quantityMilli,
              values.unit,
              values.unitLabel,
              values.note,
              scope.actorId,
            ],
          );
          const row = inserted.rows[0];
          if (row) {
            await insertShoppingEvent(client, scope, row.id, "created", {
              source: "free",
            });
            return {
              statusCode: 201,
              response: {
                deduplicated: false,
                item: toShoppingItemView(row),
              } as unknown as JsonValue,
            };
          }
          const concurrent = await findActiveShoppingItem(client, scope, normalized.key);
          if (!concurrent) throw new Error("Item de compra não foi criado.");
          return {
            statusCode: 200,
            response: {
              deduplicated: true,
              item: toShoppingItemView(concurrent),
            } as unknown as JsonValue,
          } as { statusCode: number; response: JsonValue };
        },
      }),
    );
    const response = result.response as unknown as {
      deduplicated: boolean;
      item: StockShoppingItemView;
    };
    return { replayed: result.replayed, ...response };
  }

  async purchaseShoppingItem(
    scope: StockScope,
    itemId: string,
    input: unknown,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<{
    replayed: boolean;
    item: StockShoppingItemView;
    product: StockProductView | null;
    movement: StockMovementView | null;
  }> {
    assertStockCapability(scope);
    const parsed = purchaseStockShoppingItemSchema.parse(input);
    const result = await this.withUnitOfWork(scope, async ({ client }) =>
      executeIdempotent(client, {
        scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/shopping/${itemId}/purchased`,
        key: idempotencyKey,
        request: { itemId, ...parsed, expectedVersion },
        execute: async () => {
          const current = await lockShoppingItem(client, scope, itemId);
          assertExpectedVersion(current.version, expectedVersion);
          if (current.purchased)
            throw new StockConflictError("Este item já foi marcado como comprado.");
          let productView: StockProductView | null = null;
          let movementView: StockMovementView | null = null;
          if (parsed.addToStock) {
            if (!current.product_id)
              throw new StockConflictError("Itens livres não podem ser adicionados ao estoque.");
            const product = await lockProduct(client, scope, current.product_id);
            if (product.archived) throw new StockConflictError("O produto está arquivado.");
            const amount =
              parsed.quantity === undefined || parsed.quantity === null
                ? suggestedShoppingQuantity({
                    quantityMilli: normalizeStockValue(product.quantity_milli),
                    minimumMilli: normalizeStockValue(product.minimum_milli),
                  })
                : parseStockQuantity(parsed.quantity, { allowZero: true });
            if (amount === null || amount <= 0n)
              throw new StockConflictError(
                "Informe uma quantidade positiva para adicionar ao estoque.",
              );
            const after = stockMovementAfter({
              kind: "entry",
              beforeMilli: normalizeStockValue(product.quantity_milli),
              quantityMilli: amount,
            });
            const movement = await client.query<StockMovementRow>(
              `INSERT INTO stock_movement
                (workspace_id, product_id, kind, quantity_milli, before_milli, after_milli, reason, author_id)
               VALUES ($1, $2, 'entry', $3, $4, $5, 'Compra da lista de compras', $6)
               RETURNING id, workspace_id, product_id, kind, quantity_milli, before_milli,
                         after_milli, reason, author_id, occurred_at`,
              [
                scope.workspaceId,
                product.id,
                amount,
                normalizeStockValue(product.quantity_milli),
                after,
                scope.actorId,
              ],
            );
            const movementRow = movement.rows[0];
            if (!movementRow) throw new Error("Movimentação não foi criada.");
            const updatedProduct = await client.query<StockProductRow>(
              `UPDATE stock_product
                  SET quantity_milli = $3, marked_missing = false, version = version + 1, updated_at = now()
                WHERE workspace_id = $1 AND id = $2 AND version = $4
                RETURNING id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                          marked_missing, shopping_auto, category, location, note, archived, version`,
              [scope.workspaceId, product.id, after, product.version],
            );
            const updatedRow = updatedProduct.rows[0];
            if (!updatedRow) throw new StockVersionConflictError(product.version);
            productView = toProductView(updatedRow);
            movementView = toMovementView(movementRow);
          }
          const updated = await client.query<ShoppingItemRow>(
            `UPDATE shopping_item
                SET purchased = true, purchased_at = now(), purchased_by = $3,
                    last_changed_by = $3, version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $4
              RETURNING id, workspace_id, product_id, name, source, quantity_milli,
                        quantity_milli AS effective_quantity_milli, unit, unit_label, note,
                        purchased, purchased_at, last_changed_by, version`,
            [scope.workspaceId, itemId, scope.actorId, expectedVersion],
          );
          const row = updated.rows[0];
          if (!row) throw new StockVersionConflictError(current.version);
          await insertShoppingEvent(client, scope, itemId, "purchased", {
            addToStock: parsed.addToStock,
            quantity: parsed.quantity ?? null,
          });
          return {
            statusCode: 200,
            response: {
              item: toShoppingItemView(row),
              product: productView,
              movement: movementView,
            } as unknown as JsonValue,
          };
        },
      }),
    );
    const response = result.response as unknown as {
      item: StockShoppingItemView;
      product: StockProductView | null;
      movement: StockMovementView | null;
    };
    return { replayed: result.replayed, ...response };
  }

  async listMovements(
    scope: StockScope,
    productId: string,
    limit = 100,
  ): Promise<StockMovementView[]> {
    return this.withUnitOfWork(scope, async ({ client }) => {
      const product = await client.query<{ id: string }>(
        "SELECT id FROM stock_product WHERE workspace_id = $1 AND id = $2",
        [scope.workspaceId, productId],
      );
      if (!product.rowCount) throw new StockNotFoundError();
      const result = await client.query<StockMovementRow>(
        `SELECT id, workspace_id, product_id, kind, quantity_milli, before_milli, after_milli,
                reason, author_id, occurred_at
           FROM stock_movement WHERE workspace_id = $1 AND product_id = $2
          ORDER BY occurred_at DESC, id DESC LIMIT $3`,
        [scope.workspaceId, productId, Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(toMovementView);
    });
  }

  private withUnitOfWork<T>(
    scope: StockScope,
    callback: (context: { client: PoolClient }) => Promise<T>,
    capability: "read" | "write" = "read",
  ) {
    return withUnitOfWork(
      this.pool,
      {
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        correlationId: scope.correlationId,
        applicationRole: this.applicationRole,
      },
      async ({ client }) => {
        const membership = await assertStockMembership(client, scope);
        if (capability === "write" && membership.role === "viewer") {
          throw new StockPermissionError();
        }
        return callback({ client });
      },
    );
  }
}

async function assertStockMembership(
  client: PoolClient,
  scope: StockScope,
): Promise<{ role: StockScope["role"] }> {
  const workspace = await client.query<{ status: string }>(
    `SELECT status FROM workspace WHERE id = $1 FOR UPDATE`,
    [scope.workspaceId],
  );
  if (workspace.rows[0]?.status !== "active") throw new StockPermissionError();
  const result = await client.query<{ role: StockScope["role"]; status: string }>(
    `SELECT role, status
       FROM membership
      WHERE workspace_id = $1 AND user_id = $2
      FOR UPDATE`,
    [scope.workspaceId, scope.actorId],
  );
  const membership = result.rows[0];
  if (membership?.status !== "active") throw new StockPermissionError();
  return membership;
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new StockVersionConflictError(actual);
}

function assertStockCapability(scope: StockScope): void {
  if (scope.role === "viewer") throw new StockPermissionError();
}

async function lockProduct(
  client: PoolClient,
  scope: StockScope,
  productId: string,
): Promise<StockProductRow> {
  const result = await client.query<StockProductRow>(
    `SELECT id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
            marked_missing, shopping_auto, category, location, note, archived, version
       FROM stock_product WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [scope.workspaceId, productId],
  );
  const row = result.rows[0];
  if (!row) throw new StockNotFoundError();
  return row;
}

async function syncAutomaticShoppingItems(client: PoolClient, scope: StockScope): Promise<void> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO shopping_item
      (workspace_id, product_id, name, name_normalized, source, unit, unit_label, last_changed_by)
     SELECT p.workspace_id, p.id, p.name, p.name_normalized, 'automatic', p.unit, p.unit_label, $2
       FROM stock_product p
      WHERE p.workspace_id = $1 AND p.archived = false AND p.shopping_auto = true
        AND (p.marked_missing OR p.quantity_milli = 0
             OR (p.quantity_milli IS NOT NULL AND p.minimum_milli IS NOT NULL
                 AND p.quantity_milli <= p.minimum_milli))
        AND NOT EXISTS (
          SELECT 1
            FROM shopping_item prior
           WHERE prior.workspace_id = p.workspace_id
             AND prior.product_id = p.id
             AND prior.purchased = true
             AND prior.purchased_at >= COALESCE(
               (SELECT max(m.occurred_at)
                  FROM stock_movement m
                 WHERE m.workspace_id = p.workspace_id AND m.product_id = p.id),
               '-infinity'::timestamptz
             )
        )
     ON CONFLICT (workspace_id, name_normalized) WHERE purchased = false DO NOTHING
     RETURNING id`,
    [scope.workspaceId, scope.actorId],
  );
  for (const row of inserted.rows) {
    await insertShoppingEvent(client, scope, row.id, "created", { source: "automatic" });
  }
}

async function findActiveShoppingItem(
  client: PoolClient,
  scope: StockScope,
  nameNormalized: string,
): Promise<ShoppingItemRow | null> {
  const result = await client.query<ShoppingItemRow>(
    `SELECT i.id, i.workspace_id, i.product_id, i.name, i.source,
            i.quantity_milli, i.quantity_milli AS effective_quantity_milli,
            COALESCE(p.unit, i.unit) AS unit, COALESCE(p.unit_label, i.unit_label) AS unit_label,
            i.note, i.purchased, i.purchased_at, i.last_changed_by, i.version
       FROM shopping_item i
       LEFT JOIN stock_product p ON p.workspace_id = i.workspace_id AND p.id = i.product_id
      WHERE i.workspace_id = $1 AND i.name_normalized = $2 AND i.purchased = false
      LIMIT 1
      FOR UPDATE OF i`,
    [scope.workspaceId, nameNormalized],
  );
  return result.rows[0] ?? null;
}

async function lockShoppingItem(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
): Promise<ShoppingItemRow> {
  const result = await client.query<ShoppingItemRow>(
    `SELECT i.id, i.workspace_id, i.product_id, i.name, i.source,
            i.quantity_milli, i.quantity_milli AS effective_quantity_milli,
            COALESCE(p.unit, i.unit) AS unit, COALESCE(p.unit_label, i.unit_label) AS unit_label,
            i.note, i.purchased, i.purchased_at, i.last_changed_by, i.version
       FROM shopping_item i
       LEFT JOIN stock_product p ON p.workspace_id = i.workspace_id AND p.id = i.product_id
      WHERE i.workspace_id = $1 AND i.id = $2
      FOR UPDATE OF i`,
    [scope.workspaceId, itemId],
  );
  const row = result.rows[0];
  if (!row) throw new StockNotFoundError();
  return row;
}

async function insertShoppingEvent(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
  kind: "created" | "purchased",
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO shopping_item_event (workspace_id, item_id, kind, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [scope.workspaceId, itemId, kind, scope.actorId, payload],
  );
}

function normalizeStockValue(value: bigint | string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function toProductView(row: StockProductRow): StockProductView {
  const quantityMilli = normalizeStockValue(row.quantity_milli);
  const minimumMilli = normalizeStockValue(row.minimum_milli);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    unit: row.unit,
    unitLabel: row.unit_label,
    quantity: formatStockQuantity(quantityMilli),
    minimum: formatStockQuantity(minimumMilli),
    markedMissing: row.marked_missing,
    shoppingAuto: row.shopping_auto,
    state: deriveStockState({ quantityMilli, minimumMilli, markedMissing: row.marked_missing }),
    category: row.category,
    location: row.location,
    note: row.note,
    archived: row.archived,
    version: row.version,
  };
}

function toShoppingItemView(row: ShoppingItemRow): StockShoppingItemView {
  const purchasedAt = row.purchased_at
    ? row.purchased_at instanceof Date
      ? row.purchased_at.toISOString()
      : new Date(row.purchased_at).toISOString()
    : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    name: row.name,
    source: row.source,
    quantity: formatStockQuantity(normalizeStockValue(row.effective_quantity_milli)),
    unit: row.unit,
    unitLabel: row.unit_label,
    note: row.note,
    purchased: row.purchased,
    purchasedAt,
    lastChangedBy: row.last_changed_by,
    version: row.version,
  };
}

function toMovementView(row: StockMovementRow): StockMovementView {
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : new Date(row.occurred_at).toISOString();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    productId: row.product_id,
    kind: row.kind,
    quantity: formatStockQuantity(BigInt(row.quantity_milli)) ?? "0",
    before: formatStockQuantity(normalizeStockValue(row.before_milli)),
    after: formatStockQuantity(normalizeStockValue(row.after_milli)),
    reason: row.reason,
    authorId: row.author_id,
    occurredAt,
  };
}

function normalizeStockInput(input: CreateStockProductInput) {
  return {
    unit: input.unit,
    unitLabel: input.unit === "other" ? (input.unitLabel ?? null) : (input.unitLabel ?? null),
    quantityMilli:
      input.quantity === undefined || input.quantity === null
        ? null
        : parseStockQuantity(input.quantity, { allowZero: true }),
    minimumMilli:
      input.minimum === undefined || input.minimum === null
        ? null
        : parseStockQuantity(input.minimum, { allowZero: true }),
    shoppingAuto: input.shoppingAuto ?? true,
    category: input.category ?? null,
    location: input.location ?? null,
    note: input.note ?? null,
  };
}

function normalizeUpdateInput(input: UpdateStockProductInput) {
  return {
    unit: input.unit,
    unitLabel: input.unitLabel ?? null,
    minimumMilli:
      input.minimum === undefined || input.minimum === null
        ? null
        : parseStockQuantity(input.minimum, { allowZero: true }),
    shoppingAuto: input.shoppingAuto ?? true,
    category: input.category ?? null,
    location: input.location ?? null,
    note: input.note ?? null,
  };
}

function normalizeShoppingInput(input: CreateStockShoppingItemInput) {
  return {
    quantityMilli:
      input.quantity === undefined || input.quantity === null
        ? null
        : parseStockQuantity(input.quantity, { allowZero: true }),
    unit: input.unit,
    unitLabel: input.unitLabel ?? null,
    note: input.note ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
