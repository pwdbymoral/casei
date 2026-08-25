import { createHash } from "node:crypto";

import {
  type CreateStockProductInput,
  type CreateStockShoppingItemInput,
  createStockMovementSchema,
  createStockProductSchema,
  createStockShoppingItemSchema,
  domainIdSchema,
  markStockMissingSchema,
  paginationQuerySchema,
  purchaseStockShoppingItemSchema,
  stockBulkApplyRequestSchema,
  stockBulkPreviewRequestSchema,
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
  previewStockBulk,
  type StockBulkExistingProduct,
  type StockBulkPreview,
  type StockBulkProductValues,
  stockMovementAfter,
  suggestedShoppingQuantity,
} from "@casei/domain";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./http/cursor.js";

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
  expenseTransactionId: string | null;
  lastChangedBy: string | null;
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
  state_rank?: number;
  lower_name?: string;
}

interface StockBulkProductRow extends StockProductRow {
  has_movement: boolean;
}

export interface StockBulkPreviewResult extends StockBulkPreview {
  readonly contentHash: string;
}

export interface StockBulkAppliedRow {
  readonly lineNumber: number;
  readonly action: "new" | "update";
  readonly productId: string;
}

export interface StockBulkApplyResult {
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly committed: boolean;
  readonly preview: StockBulkPreviewResult;
  readonly applied: readonly StockBulkAppliedRow[];
}

export interface StockPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
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
  occurred_at_cursor?: string;
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
  expense_transaction_id: string | null;
  last_changed_by: string | null;
  version: number;
}

export class StockService {
  private readonly applicationRole: string;
  private readonly cursorSecret: string;

  constructor(
    private readonly pool: Pool,
    options: { applicationRole?: string; cursorSecret?: string } = {},
  ) {
    this.applicationRole = options.applicationRole ?? "casei_app";
    const cursorSecret = options.cursorSecret ?? process.env.CASEI_CURSOR_SECRET;
    if (process.env.NODE_ENV === "production" && !cursorSecret) {
      throw new Error("CASEI_CURSOR_SECRET is required in production");
    }
    this.cursorSecret = cursorSecret ?? "development-only-cursor-secret";
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
            await lockShoppingName(client, scope, normalized.key);
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
              await syncAutomaticShoppingItems(client, scope, row.id);
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
    query: {
      query?: string;
      includeArchived?: boolean;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<StockPage<StockProductView>> {
    const parsed = stockProductListQuerySchema.parse(query);
    const search = parsed.query ? `%${normalizeProductName(parsed.query).key}%` : null;
    return this.withUnitOfWork(scope, async ({ client }) => {
      const values: unknown[] = [scope.workspaceId, parsed.includeArchived, search];
      const conditions = [
        "workspace_id = $1",
        "($2::boolean OR archived = false)",
        "($3::text IS NULL OR name_normalized LIKE $3)",
      ];
      if (parsed.cursor) {
        const [archived, stateRank, lowerName, id] = decodeStockProductCursor(
          parsed.cursor,
          this.cursorSecret,
        );
        values.push(archived, stateRank, lowerName, id);
        const archivedParam = values.length - 3;
        const stateRankParam = values.length - 2;
        const lowerNameParam = values.length - 1;
        const idParam = values.length;
        conditions.push(
          `(archived > $${archivedParam}::boolean
            OR (archived = $${archivedParam}::boolean AND ${stockStateRankSql} > $${stateRankParam}::int)
            OR (archived = $${archivedParam}::boolean AND ${stockStateRankSql} = $${stateRankParam}::int
                AND lower(name) > $${lowerNameParam}::text)
            OR (archived = $${archivedParam}::boolean AND ${stockStateRankSql} = $${stateRankParam}::int
                AND lower(name) = $${lowerNameParam}::text AND id > $${idParam}::uuid))`,
        );
      }
      values.push(parsed.limit + 1);
      const limitParam = values.length;
      const result = await client.query<StockProductRow>(
        `SELECT id, workspace_id, name, unit, unit_label, quantity_milli, minimum_milli,
                marked_missing, shopping_auto, category, location, note, archived, version,
                ${stockStateRankSql} AS state_rank, lower(name) AS lower_name
           FROM stock_product
          WHERE ${conditions.join(" AND ")}
          ORDER BY archived ASC,
                   state_rank ASC, lower_name ASC, id ASC
          LIMIT $${limitParam}`,
        values,
      );
      const hasMore = result.rows.length > parsed.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.limit) : result.rows;
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor(
              {
                ordering: stockProductCursorOrdering,
                position: [
                  last.archived,
                  stockProductStateRank(last),
                  stockProductLowerName(last),
                  last.id,
                ],
              },
              this.cursorSecret,
            )
          : null;
      return { items: rows.map(toProductView), nextCursor, hasMore };
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
    return this.withUnitOfWork(
      scope,
      async ({ client }) => {
        const requestedName = parsed.name ? normalizeProductName(parsed.name) : null;
        const observedName = requestedName ?? (await readProductName(client, scope, productId));
        await lockShoppingName(client, scope, (requestedName ?? observedName).key);
        const current = await lockProduct(client, scope, productId);
        assertExpectedVersion(current.version, expectedVersion);
        const normalized = requestedName ?? normalizeProductName(current.name);
        const values = normalizeUpdateInput(parsed, current);
        if (values.unit === "other" && !values.unitLabel) {
          throw new StockConflictError("Informe o rótulo da unidade.");
        }
        if (normalizeProductName(current.name).key !== normalized.key) {
          await assertNoFreeShoppingNameCollision(client, scope, normalized.key);
        }
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
          await syncAutomaticShoppingItems(client, scope, productId);
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

  async previewBulkProducts(scope: StockScope, input: unknown): Promise<StockBulkPreviewResult> {
    const parsed = stockBulkPreviewRequestSchema.parse(input);
    const contentHash = hashBulkContent(parsed.content);
    const preview = await this.withUnitOfWork(scope, async ({ client }) => {
      const products = await loadBulkProducts(client, scope);
      return previewStockBulk(parsed.content, products.map(toBulkExistingProduct));
    });
    return { ...preview, contentHash };
  }

  async applyBulkProducts(
    scope: StockScope,
    input: unknown,
    idempotencyKey: string,
  ): Promise<StockBulkApplyResult> {
    const parsed = stockBulkApplyRequestSchema.parse(input);
    const contentHash = hashBulkContent(parsed.content);
    if (parsed.previewHash !== contentHash) {
      throw new StockConflictError("A confirmação precisa usar exatamente o conteúdo revisado.");
    }
    const result = await this.withUnitOfWork(
      scope,
      async ({ client }) =>
        executeIdempotent(client, {
          scope: `${scope.actorId}:${scope.workspaceId}:POST:/stock/products/bulk`,
          key: idempotencyKey,
          request: parsed,
          execute: async () => {
            const products = await loadBulkProducts(client, scope);
            const preview = previewStockBulk(parsed.content, products.map(toBulkExistingProduct));
            const previewResult: StockBulkPreviewResult = { ...preview, contentHash };
            const canApply =
              parsed.mode === "valid_only"
                ? preview.canApplyValidOnly
                : preview.canApplyAllOrNothing;
            if (!canApply) {
              return {
                statusCode: 422,
                response: {
                  committed: false,
                  preview: previewResult,
                  applied: [],
                } as unknown as JsonValue,
              };
            }

            const productsById = new Map(products.map((product) => [product.id, product]));
            const applied: StockBulkAppliedRow[] = [];
            for (const row of preview.rows) {
              if (row.status !== "new" && row.status !== "update") continue;
              if (!row.values) throw new Error("A prévia não contém valores aplicáveis.");
              if (row.status === "new") {
                const productId = await insertBulkProduct(client, scope, row.values);
                applied.push({ lineNumber: row.lineNumber, action: "new", productId });
                continue;
              }
              const current = row.existingProductId
                ? productsById.get(row.existingProductId)
                : undefined;
              if (!current) throw new StockVersionConflictError(0);
              const productId = await updateBulkProduct(client, scope, current, row.values);
              applied.push({ lineNumber: row.lineNumber, action: "update", productId });
            }
            return {
              statusCode: 200,
              response: {
                committed: true,
                preview: previewResult,
                applied,
              } as unknown as JsonValue,
            };
          },
        }),
      "write",
    );
    const response = result.response as unknown as {
      committed: boolean;
      preview: StockBulkPreviewResult;
      applied: readonly StockBulkAppliedRow[];
    };
    return {
      replayed: result.replayed,
      statusCode: result.statusCode,
      ...response,
    };
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
            const observedName = await readProductName(client, scope, productId);
            await lockShoppingName(client, scope, observedName.key);
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
              await assertNoFreeShoppingNameCollision(
                client,
                scope,
                normalizeProductName(current.name).key,
              );
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
            await syncAutomaticShoppingItems(client, scope, productId);
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
            await syncAutomaticShoppingItems(client, scope, productId);
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
            await syncAutomaticShoppingItems(client, scope, productId);
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
        `WITH visible_items AS (
          SELECT i.id, i.workspace_id, i.product_id, i.name, i.source,
                 i.quantity_milli,
                 CASE WHEN p.id IS NULL THEN i.quantity_milli
                      WHEN p.minimum_milli IS NULL THEN NULL
                      ELSE GREATEST(p.minimum_milli - COALESCE(p.quantity_milli, 0), 0)
                 END AS effective_quantity_milli,
                 COALESCE(p.unit, i.unit) AS unit,
                 COALESCE(p.unit_label, i.unit_label) AS unit_label,
                 i.note, i.purchased, i.purchased_at, i.expense_transaction_id,
                 i.last_changed_by, i.version
            FROM shopping_item i
            LEFT JOIN stock_product p
              ON p.workspace_id = i.workspace_id AND p.id = i.product_id
           WHERE i.workspace_id = $1
             AND ($2::boolean OR i.purchased = false)
             AND (i.purchased OR ((i.source = 'free') OR (i.source = 'automatic' AND p.id IS NOT NULL
                  AND p.shopping_auto = true
                  AND (p.marked_missing OR p.quantity_milli = 0
                       OR (p.quantity_milli IS NOT NULL AND p.minimum_milli IS NOT NULL
                           AND p.quantity_milli <= p.minimum_milli)))))
        ),
        derived_items AS (
          SELECT p.id, p.workspace_id, p.id AS product_id, p.name, 'automatic' AS source,
                 NULL::bigint AS quantity_milli,
                 CASE WHEN p.minimum_milli IS NULL THEN NULL::bigint
                      ELSE GREATEST(p.minimum_milli - COALESCE(p.quantity_milli, 0), 0)
                 END AS effective_quantity_milli,
                 p.unit, p.unit_label, p.note,
                 false AS purchased, NULL::timestamptz AS purchased_at,
                 NULL::uuid AS expense_transaction_id,
                 NULL::text AS last_changed_by, p.version
            FROM stock_product p
           WHERE p.workspace_id = $1 AND p.archived = false AND p.shopping_auto = true
             AND (p.marked_missing OR p.quantity_milli = 0
                  OR (p.quantity_milli IS NOT NULL AND p.minimum_milli IS NOT NULL
                      AND p.quantity_milli <= p.minimum_milli))
             AND NOT EXISTS (
                   SELECT 1 FROM shopping_item active
                    WHERE active.workspace_id = p.workspace_id
                      AND active.purchased = false
                      AND (active.product_id = p.id
                           OR active.name_normalized = p.name_normalized)
                 )
             AND NOT EXISTS (
                   SELECT 1 FROM shopping_item prior
                    WHERE prior.workspace_id = p.workspace_id
                      AND prior.product_id = p.id
                      AND prior.purchased = true
                      AND prior.purchased_at > COALESCE(
                            (SELECT max(m.occurred_at)
                               FROM stock_movement m
                              WHERE m.workspace_id = p.workspace_id AND m.product_id = p.id),
                            '-infinity'::timestamptz
                          )
                 )
        )
        SELECT shopping.id, shopping.workspace_id, shopping.product_id, shopping.name,
               shopping.source, shopping.quantity_milli, shopping.effective_quantity_milli,
               shopping.unit, shopping.unit_label, shopping.note, shopping.purchased,
               shopping.purchased_at, shopping.expense_transaction_id,
               shopping.last_changed_by, shopping.version
          FROM (
            SELECT * FROM visible_items
            UNION ALL
            SELECT * FROM derived_items
          ) shopping
         WHERE $2::boolean OR shopping.purchased = false
         ORDER BY shopping.purchased ASC, shopping.source ASC, lower(shopping.name), shopping.id
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
          await lockShoppingName(client, scope, normalized.key);
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
                       purchased, purchased_at, expense_transaction_id, last_changed_by, version`,
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
          const current = await lockOrMaterializeAutomaticItem(client, scope, itemId);
          assertExpectedVersion(current.version, expectedVersion);
          if (current.purchased)
            throw new StockConflictError("Este item já foi marcado como comprado.");
          const expenseTransactionId = parsed.expenseTransactionId ?? null;
          if (expenseTransactionId) {
            await assertPurchasableExpense(client, scope, expenseTransactionId);
          }
          const automaticProduct =
            current.source === "automatic" && current.product_id
              ? await lockProduct(client, scope, current.product_id)
              : null;
          if (automaticProduct && automaticProduct.version !== current.version) {
            throw new StockVersionConflictError(automaticProduct.version);
          }
          let productView: StockProductView | null = null;
          let movementView: StockMovementView | null = null;
          const productId = current.product_id;
          if (parsed.addToStock) {
            if (!productId)
              throw new StockConflictError("Itens livres não podem ser adicionados ao estoque.");
            const product = automaticProduct ?? (await lockProduct(client, scope, productId));
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
                SET purchased = true, purchased_at = now(), expense_transaction_id = $3,
                    purchased_by = $4, last_changed_by = $4, version = version + 1, updated_at = now()
              WHERE workspace_id = $1 AND id = $2 AND version = $5
              RETURNING id, workspace_id, product_id, name, source, quantity_milli,
                        quantity_milli AS effective_quantity_milli, unit, unit_label, note,
                        purchased, purchased_at, expense_transaction_id, last_changed_by, version`,
            [scope.workspaceId, current.id, expenseTransactionId, scope.actorId, expectedVersion],
          );
          const row = updated.rows[0];
          if (!row) throw new StockVersionConflictError(current.version);
          await insertShoppingEvent(client, scope, current.id, "purchased", {
            addToStock: parsed.addToStock,
            quantity: parsed.quantity ?? null,
            expenseTransactionId,
          });
          if (parsed.addToStock && productId)
            await syncAutomaticShoppingItems(client, scope, productId);
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
    query: { cursor?: string; limit?: number } = {},
  ): Promise<StockPage<StockMovementView>> {
    const parsed = paginationQuerySchema.parse(query);
    return this.withUnitOfWork(scope, async ({ client }) => {
      const product = await client.query<{ id: string }>(
        "SELECT id FROM stock_product WHERE workspace_id = $1 AND id = $2",
        [scope.workspaceId, productId],
      );
      if (!product.rowCount) throw new StockNotFoundError();
      const values: unknown[] = [scope.workspaceId, productId];
      const conditions = ["workspace_id = $1", "product_id = $2"];
      if (parsed.cursor) {
        const [occurredAt, id] = decodeStockMovementCursor(parsed.cursor, this.cursorSecret);
        values.push(occurredAt, id);
        const occurredAtParam = values.length - 1;
        const idParam = values.length;
        conditions.push(
          `(occurred_at < $${occurredAtParam}::timestamptz
            OR (occurred_at = $${occurredAtParam}::timestamptz AND id < $${idParam}::uuid))`,
        );
      }
      values.push(parsed.limit + 1);
      const limitParam = values.length;
      const result = await client.query<StockMovementRow>(
        `SELECT id, workspace_id, product_id, kind, quantity_milli, before_milli, after_milli,
                reason, author_id, occurred_at, occurred_at::text AS occurred_at_cursor
           FROM stock_movement WHERE ${conditions.join(" AND ")}
          ORDER BY occurred_at DESC, id DESC LIMIT $${limitParam}`,
        values,
      );
      const hasMore = result.rows.length > parsed.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.limit) : result.rows;
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor(
              {
                ordering: stockMovementCursorOrdering,
                position: [movementCursorPosition(last), last.id],
              },
              this.cursorSecret,
            )
          : null;
      return { items: rows.map(toMovementView), nextCursor, hasMore };
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
  const result = await client.query<{ role: StockScope["role"]; status: string }>(
    `SELECT role, status
       FROM membership
      WHERE workspace_id = $1 AND user_id = $2
      FOR UPDATE`,
    [scope.workspaceId, scope.actorId],
  );
  const membership = result.rows[0];
  if (membership?.status !== "active") throw new StockPermissionError();
  // Keep the same membership -> workspace order used by IdentityService.withScoped.
  const workspace = await client.query<{ status: string }>(
    `SELECT status FROM workspace WHERE id = $1 FOR UPDATE`,
    [scope.workspaceId],
  );
  if (workspace.rows[0]?.status !== "active") throw new StockPermissionError();
  return membership;
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new StockVersionConflictError(actual);
}

function assertStockCapability(scope: StockScope): void {
  if (scope.role === "viewer") throw new StockPermissionError();
}

async function readProductName(
  client: PoolClient,
  scope: StockScope,
  productId: string,
): Promise<ReturnType<typeof normalizeProductName>> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM stock_product WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, productId],
  );
  const row = result.rows[0];
  if (!row) throw new StockNotFoundError();
  return normalizeProductName(row.name);
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

/**
 * A purchase may reference an existing expense only when the caller makes
 * that choice explicitly. This validation intentionally does not create,
 * mutate, or infer any finance transaction.
 */
async function assertPurchasableExpense(
  client: PoolClient,
  scope: StockScope,
  transactionId: string,
): Promise<void> {
  const result = await client.query<{ kind: string; state: string }>(
    `SELECT kind, state
       FROM finance_transaction
      WHERE workspace_id = $1 AND id = $2
      FOR SHARE`,
    [scope.workspaceId, transactionId],
  );
  const row = result.rows[0];
  if (row?.kind !== "expense" || row.state === "canceled") {
    throw new StockConflictError(
      "Vincule uma despesa financeira ativa deste espaço para concluir a compra.",
    );
  }
}

async function syncAutomaticShoppingItems(
  client: PoolClient,
  scope: StockScope,
  productId: string,
): Promise<void> {
  // A free item can predate a product with the same normalized name. When the
  // product is actually a shopping candidate, convert that row in place so
  // its history and idempotency identity survive without a disappearing or
  // duplicate projection. If the product is not low/missing, the free item
  // remains visible as an explicit user request.
  await client.query(
    `UPDATE shopping_item i
        SET product_id = p.id, source = 'automatic', name = p.name,
            name_normalized = p.name_normalized, quantity_milli = NULL,
            unit = p.unit, unit_label = p.unit_label, version = p.version,
            last_changed_by = $2, updated_at = now()
       FROM stock_product p
      WHERE i.workspace_id = $1 AND i.source = 'free' AND i.purchased = false
        AND i.name_normalized = p.name_normalized AND p.workspace_id = $1
        AND p.id = $3 AND p.archived = false AND p.shopping_auto = true
        AND (p.marked_missing OR p.quantity_milli = 0
             OR (p.quantity_milli IS NOT NULL AND p.minimum_milli IS NOT NULL
                 AND p.quantity_milli <= p.minimum_milli))
      RETURNING i.id`,
    [scope.workspaceId, scope.actorId, productId],
  );
  await client.query(
    `UPDATE shopping_item i
        SET name = p.name, name_normalized = p.name_normalized,
            unit = p.unit, unit_label = p.unit_label,
            version = p.version, last_changed_by = $2, updated_at = now()
       FROM stock_product p
      WHERE i.workspace_id = $1 AND i.product_id = p.id AND p.workspace_id = $1
        AND i.product_id = $3 AND i.source = 'automatic' AND i.purchased = false
        AND i.version <> p.version`,
    [scope.workspaceId, scope.actorId, productId],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO shopping_item
      (workspace_id, product_id, name, name_normalized, source, unit, unit_label, last_changed_by, version)
     SELECT p.workspace_id, p.id, p.name, p.name_normalized, 'automatic', p.unit, p.unit_label, $2, p.version
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
             AND prior.purchased_at > COALESCE(
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
            i.note, i.purchased, i.purchased_at, i.expense_transaction_id,
            i.last_changed_by, i.version
       FROM shopping_item i
       LEFT JOIN stock_product p ON p.workspace_id = i.workspace_id AND p.id = i.product_id
      WHERE i.workspace_id = $1 AND i.name_normalized = $2 AND i.purchased = false
      LIMIT 1
      FOR UPDATE OF i`,
    [scope.workspaceId, nameNormalized],
  );
  return result.rows[0] ?? null;
}

/** Serializes product/free-item operations on the same workspace/name key. */
async function lockShoppingName(
  client: PoolClient,
  scope: StockScope,
  nameNormalized: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    scope.workspaceId,
    nameNormalized,
  ]);
}

async function assertNoFreeShoppingNameCollision(
  client: PoolClient,
  scope: StockScope,
  nameNormalized: string,
): Promise<void> {
  const collision = await client.query<{ id: string }>(
    `SELECT id
       FROM shopping_item
      WHERE workspace_id = $1
        AND name_normalized = $2
        AND purchased = false
        AND source = 'free'
      LIMIT 1
      FOR UPDATE`,
    [scope.workspaceId, nameNormalized],
  );
  if (collision.rowCount) {
    throw new StockConflictError(
      "O nome já está em um item livre da lista; conclua ou remova esse item antes de alterar o produto.",
    );
  }
}

async function lockShoppingItem(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
): Promise<ShoppingItemRow | null> {
  return queryShoppingItem(client, scope, itemId, true);
}

async function findShoppingItem(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
): Promise<ShoppingItemRow | null> {
  return queryShoppingItem(client, scope, itemId, false);
}

async function queryShoppingItem(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
  lock: boolean,
): Promise<ShoppingItemRow | null> {
  const result = await client.query<ShoppingItemRow>(
    `SELECT i.id, i.workspace_id, i.product_id, i.name, i.source,
            i.quantity_milli, i.quantity_milli AS effective_quantity_milli,
            COALESCE(p.unit, i.unit) AS unit, COALESCE(p.unit_label, i.unit_label) AS unit_label,
            i.note, i.purchased, i.purchased_at, i.expense_transaction_id,
            i.last_changed_by, i.version
       FROM shopping_item i
       LEFT JOIN stock_product p ON p.workspace_id = i.workspace_id AND p.id = i.product_id
      WHERE i.workspace_id = $1 AND i.id = $2
      ${lock ? "FOR UPDATE OF i" : ""}`,
    [scope.workspaceId, itemId],
  );
  return result.rows[0] ?? null;
}

/**
 * A low/missing automatic product may be projected by GET before a shopping row
 * exists. Materialize that projection only inside the purchase transaction so
 * the normal append-only shopping history and If-Match contract still apply.
 */
async function lockOrMaterializeAutomaticItem(
  client: PoolClient,
  scope: StockScope,
  itemId: string,
): Promise<ShoppingItemRow> {
  const observed = await findShoppingItem(client, scope, itemId);
  if (observed) {
    if (observed.source === "automatic" && observed.product_id) {
      await lockProduct(client, scope, observed.product_id);
    }
    const existing = await lockShoppingItem(client, scope, itemId);
    if (!existing) throw new StockNotFoundError();
    return existing;
  }

  const product = await lockProduct(client, scope, itemId);
  if (!isAutomaticShoppingCandidate(product)) throw new StockNotFoundError();
  if (await hasSuppressedAutomaticPurchase(client, scope, product.id)) {
    throw new StockConflictError(
      "Este item já foi marcado como comprado; faça uma movimentação no estoque antes de comprá-lo novamente.",
    );
  }

  const normalized = normalizeProductName(product.name);
  const inserted = await client.query<ShoppingItemRow>(
    `INSERT INTO shopping_item
      (workspace_id, product_id, name, name_normalized, source, unit, unit_label,
       last_changed_by, version)
     VALUES ($1, $2, $3, $4, 'automatic', $5, $6, $7, $8)
     ON CONFLICT (workspace_id, name_normalized) WHERE purchased = false DO NOTHING
     RETURNING id, workspace_id, product_id, name, source, quantity_milli,
               quantity_milli AS effective_quantity_milli, unit, unit_label, note,
               purchased, purchased_at, expense_transaction_id, last_changed_by, version`,
    [
      scope.workspaceId,
      product.id,
      product.name,
      normalized.key,
      product.unit,
      product.unit_label,
      scope.actorId,
      product.version,
    ],
  );
  const row = inserted.rows[0];
  if (row) {
    await insertShoppingEvent(client, scope, row.id, "created", { source: "automatic" });
    return row;
  }

  const concurrent = await findActiveShoppingItem(client, scope, normalized.key);
  if (!concurrent) throw new StockNotFoundError();
  return concurrent;
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

async function hasSuppressedAutomaticPurchase(
  client: PoolClient,
  scope: StockScope,
  productId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM shopping_item prior
      WHERE prior.workspace_id = $1
        AND prior.product_id = $2
        AND prior.purchased = true
        AND prior.purchased_at > COALESCE(
          (SELECT max(m.occurred_at)
             FROM stock_movement m
            WHERE m.workspace_id = $1 AND m.product_id = $2),
          '-infinity'::timestamptz
        )
      LIMIT 1`,
    [scope.workspaceId, productId],
  );
  return (result.rowCount ?? 0) > 0;
}

function hashBulkContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function loadBulkProducts(
  client: PoolClient,
  scope: StockScope,
): Promise<StockBulkProductRow[]> {
  const result = await client.query<StockBulkProductRow>(
    `SELECT p.id, p.workspace_id, p.name, p.unit, p.unit_label, p.quantity_milli,
            p.minimum_milli, p.marked_missing, p.shopping_auto, p.category, p.location,
            p.note, p.archived, p.version,
            EXISTS (
              SELECT 1 FROM stock_movement m
               WHERE m.workspace_id = p.workspace_id AND m.product_id = p.id
            ) AS has_movement
       FROM stock_product p
      WHERE p.workspace_id = $1 AND p.archived = false`,
    [scope.workspaceId],
  );
  return result.rows;
}

async function lockBulkProduct(
  client: PoolClient,
  scope: StockScope,
  productId: string,
): Promise<StockBulkProductRow> {
  const result = await client.query<StockBulkProductRow>(
    `SELECT p.id, p.workspace_id, p.name, p.unit, p.unit_label, p.quantity_milli,
            p.minimum_milli, p.marked_missing, p.shopping_auto, p.category, p.location,
            p.note, p.archived, p.version,
            EXISTS (
              SELECT 1 FROM stock_movement m
               WHERE m.workspace_id = p.workspace_id AND m.product_id = p.id
            ) AS has_movement
       FROM stock_product p
      WHERE p.workspace_id = $1 AND p.id = $2
      FOR UPDATE`,
    [scope.workspaceId, productId],
  );
  const row = result.rows[0];
  if (!row) throw new StockNotFoundError();
  return row;
}

function toBulkExistingProduct(row: StockBulkProductRow): StockBulkExistingProduct {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    unitLabel: row.unit_label,
    quantity: formatStockQuantity(normalizeStockValue(row.quantity_milli)),
    minimum: formatStockQuantity(normalizeStockValue(row.minimum_milli)),
    markedMissing: row.marked_missing,
    shoppingAuto: row.shopping_auto,
    category: row.category,
    location: row.location,
    note: row.note,
    version: row.version,
    hasMovement: row.has_movement,
  };
}

function bulkQuantity(value: string | undefined): bigint | null {
  return value === undefined ? null : parseStockQuantity(value, { allowZero: true });
}

async function insertBulkProduct(
  client: PoolClient,
  scope: StockScope,
  values: StockBulkProductValues,
): Promise<string> {
  const normalized = normalizeProductName(values.name);
  const quantityMilli = bulkQuantity(values.quantity);
  const minimumMilli = bulkQuantity(values.minimum);
  await lockShoppingName(client, scope, normalized.key);
  try {
    const inserted = await client.query<StockProductRow>(
      `INSERT INTO stock_product
        (workspace_id, name, name_normalized, unit, unit_label, quantity_milli,
         minimum_milli, marked_missing, shopping_auto, category, location, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, workspace_id, name, unit, unit_label, quantity_milli,
                 minimum_milli, marked_missing, shopping_auto, category, location, note, archived, version`,
      [
        scope.workspaceId,
        normalized.display,
        normalized.key,
        values.unit ?? "unit",
        values.unitLabel ?? null,
        quantityMilli,
        minimumMilli,
        values.markedMissing ?? false,
        values.shoppingAuto ?? true,
        values.category ?? null,
        values.location ?? null,
        values.note ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Produto do lote não foi criado.");
    if (quantityMilli !== null) {
      await client.query(
        `INSERT INTO stock_movement
          (workspace_id, product_id, kind, quantity_milli, before_milli, after_milli, reason, author_id)
         VALUES ($1, $2, 'entry', $3, NULL, $3, 'Cadastro em lote', $4)`,
        [scope.workspaceId, row.id, quantityMilli, scope.actorId],
      );
    }
    await syncAutomaticShoppingItems(client, scope, row.id);
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StockConflictError("Já existe um produto ativo com esse nome.");
    }
    throw error;
  }
}

async function updateBulkProduct(
  client: PoolClient,
  scope: StockScope,
  current: StockBulkProductRow,
  values: StockBulkProductValues,
): Promise<string> {
  const normalized = normalizeProductName(values.name);
  await lockShoppingName(client, scope, normalized.key);
  const locked = await lockBulkProduct(client, scope, current.id);
  if (locked.version !== current.version) throw new StockVersionConflictError(locked.version);
  current = locked;
  if (normalizeProductName(current.name).key !== normalized.key) {
    await assertNoFreeShoppingNameCollision(client, scope, normalized.key);
  }
  const currentQuantity = normalizeStockValue(current.quantity_milli);
  const nextQuantity =
    values.quantity === undefined ? currentQuantity : bulkQuantity(values.quantity);
  const quantityChanged = nextQuantity !== currentQuantity;
  const minimumMilli =
    values.minimum === undefined
      ? normalizeStockValue(current.minimum_milli)
      : bulkQuantity(values.minimum);
  const markedMissing = values.markedMissing ?? current.marked_missing;
  const shoppingAuto = values.shoppingAuto ?? current.shopping_auto;
  const unit = values.unit ?? current.unit;
  const unitLabel = values.unitLabel ?? current.unit_label;
  const category = values.category ?? current.category;
  const location = values.location ?? current.location;
  const note = values.note ?? current.note;

  if (quantityChanged) {
    await client.query(
      `INSERT INTO stock_movement
        (workspace_id, product_id, kind, quantity_milli, before_milli, after_milli, reason, author_id)
       VALUES ($1, $2, 'correction', $3, $4, $5, 'Cadastro em lote', $6)`,
      [
        scope.workspaceId,
        current.id,
        nextQuantity ?? 0n,
        currentQuantity,
        nextQuantity,
        scope.actorId,
      ],
    );
  }
  try {
    const updated = await client.query<StockProductRow>(
      `UPDATE stock_product
          SET name = $3, name_normalized = $4, unit = $5, unit_label = $6,
              quantity_milli = $7, minimum_milli = $8, marked_missing = $9,
              shopping_auto = $10, category = $11, location = $12, note = $13,
              version = version + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND version = $14
       RETURNING id, workspace_id, name, unit, unit_label, quantity_milli,
                 minimum_milli, marked_missing, shopping_auto, category, location, note, archived, version`,
      [
        scope.workspaceId,
        current.id,
        normalized.display,
        normalized.key,
        unit,
        unitLabel,
        nextQuantity,
        minimumMilli,
        markedMissing,
        shoppingAuto,
        category,
        location,
        note,
        current.version,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw new StockVersionConflictError(current.version);
    await syncAutomaticShoppingItems(client, scope, row.id);
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StockConflictError("Já existe um produto ativo com esse nome.");
    }
    throw error;
  }
}

function normalizeStockValue(value: bigint | string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function isAutomaticShoppingCandidate(product: StockProductRow): boolean {
  const quantity = normalizeStockValue(product.quantity_milli);
  const minimum = normalizeStockValue(product.minimum_milli);
  return (
    !product.archived &&
    product.shopping_auto &&
    (product.marked_missing ||
      quantity === 0n ||
      (quantity !== null && minimum !== null && quantity <= minimum))
  );
}

const stockProductCursorOrdering = "archived,state_rank,lower_name,id";
const stockMovementCursorOrdering = "occurred_at,id";
const stockStateRankSql = `CASE WHEN marked_missing OR quantity_milli = 0 THEN 0
                             WHEN minimum_milli IS NOT NULL AND quantity_milli <= minimum_milli THEN 1
                             ELSE 2 END`;

function stockProductStateRank(row: StockProductRow): number {
  if (typeof row.state_rank === "number") return row.state_rank;
  const quantity = normalizeStockValue(row.quantity_milli);
  const minimum = normalizeStockValue(row.minimum_milli);
  if (row.marked_missing || quantity === 0n) return 0;
  if (minimum !== null && quantity !== null && quantity <= minimum) return 1;
  return 2;
}

function stockProductLowerName(row: StockProductRow): string {
  return row.lower_name ?? row.name.toLocaleLowerCase();
}

function decodeStockProductCursor(
  cursor: string,
  secret: string,
): [boolean, number, string, string] {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== stockProductCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 4 ||
    typeof position[0] !== "boolean" ||
    typeof position[1] !== "number" ||
    !Number.isInteger(position[1]) ||
    position[1] < 0 ||
    position[1] > 2 ||
    typeof position[2] !== "string" ||
    typeof position[3] !== "string" ||
    !domainIdSchema.safeParse(position[3]).success
  ) {
    throw new InvalidCursorError();
  }
  return [position[0], position[1], position[2], position[3]];
}

function decodeStockMovementCursor(cursor: string, secret: string): [string, string] {
  const payload = decodeCursor(cursor, secret);
  const position = payload.position;
  if (
    payload.ordering !== stockMovementCursorOrdering ||
    !Array.isArray(position) ||
    position.length !== 2 ||
    typeof position[0] !== "string" ||
    typeof position[1] !== "string" ||
    Number.isNaN(Date.parse(position[0])) ||
    !domainIdSchema.safeParse(position[1]).success
  ) {
    throw new InvalidCursorError();
  }
  return [position[0], position[1]];
}

function movementCursorPosition(row: StockMovementRow): string {
  return row.occurred_at_cursor ?? toMovementView(row).occurredAt;
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
    expenseTransactionId: row.expense_transaction_id,
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

function normalizeUpdateInput(input: UpdateStockProductInput, current: StockProductRow) {
  return {
    unit: input.unit ?? current.unit,
    unitLabel: input.unitLabel === undefined ? current.unit_label : input.unitLabel,
    minimumMilli:
      input.minimum === undefined
        ? normalizeStockValue(current.minimum_milli)
        : input.minimum === null
          ? null
          : parseStockQuantity(input.minimum, { allowZero: true }),
    shoppingAuto: input.shoppingAuto ?? current.shopping_auto,
    category: input.category === undefined ? current.category : input.category,
    location: input.location === undefined ? current.location : input.location,
    note: input.note === undefined ? current.note : input.note,
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
