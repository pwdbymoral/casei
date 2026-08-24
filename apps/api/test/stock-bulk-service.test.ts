import { createHash } from "node:crypto";
import type { Pool } from "@casei/database";
import { describe, expect, it } from "vitest";
import { StockService } from "../src/stock-service.js";

const scope = {
  workspaceId: "0190f3c8-2a10-7abc-8def-1234567890ab",
  actorId: "user-1",
  correlationId: "correlation-1",
  role: "member" as const,
};

const existingProduct = {
  id: "0190f3c8-2a10-7abc-8def-1234567890ac",
  workspace_id: scope.workspaceId,
  name: "Arroz",
  unit: "kg",
  unit_label: null,
  quantity_milli: "1000",
  minimum_milli: "500",
  marked_missing: false,
  shopping_auto: true,
  category: null,
  location: null,
  note: null,
  archived: false,
  version: 2,
  has_movement: true,
};

function bulkPool(rows: readonly Record<string, unknown>[] = [existingProduct]) {
  const statements: string[] = [];
  const products = [...rows];
  let nextId = 0;
  const client = {
    async query<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(sql);
      if (sql.includes("FROM membership")) {
        return { rows: [{ role: "member", status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM workspace")) {
        return { rows: [{ status: "active" }] as T[], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO "idempotency_key"')) {
        return { rows: [{ id: "idempotency-1" }] as T[], rowCount: 1 };
      }
      if (sql.includes("FROM stock_product p")) {
        return { rows: products as T[], rowCount: products.length };
      }
      if (sql.includes("INSERT INTO stock_product")) {
        nextId += 1;
        const quantity = values[5] === null ? null : String(values[5]);
        const row = {
          ...existingProduct,
          id: `0190f3c8-2a10-7abc-8def-1234567890b${nextId}`,
          name: values[1],
          unit: values[3],
          unit_label: values[4],
          quantity_milli: quantity,
          minimum_milli: values[6] === null ? null : String(values[6]),
          marked_missing: values[7],
          shopping_auto: values[8],
          category: values[9],
          location: values[10],
          note: values[11],
          version: 0,
          has_movement: false,
        };
        products.push(row);
        return { rows: [row as T], rowCount: 1 };
      }
      if (sql.includes("UPDATE stock_product")) {
        const id = values[1];
        const index = products.findIndex((product) => product.id === id);
        const current = products[index];
        if (!current) return { rows: [], rowCount: 0 };
        const row = {
          ...current,
          name: values[2],
          unit: values[4],
          unit_label: values[5],
          quantity_milli: values[6] === null ? null : String(values[6]),
          minimum_milli: values[7] === null ? null : String(values[7]),
          marked_missing: values[8],
          shopping_auto: values[9],
          category: values[10],
          location: values[11],
          note: values[12],
          version: Number(current.version) + 1,
        };
        products[index] = row;
        return { rows: [row as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    } as unknown as Pool,
    statements,
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("STOCK-004 serviço de cadastro em lote", () => {
  it("recalcula a prévia sob lock e não aplica inválidas no modo tudo-ou-nada", async () => {
    const content = "Nome\tQuantidade\nArroz\t2\n\t1";
    const setup = bulkPool();
    const service = new StockService(setup.pool);

    const result = await service.applyBulkProducts(
      scope,
      { content, mode: "all_or_nothing", previewHash: hash(content) },
      "stock-bulk-service-0001",
    );

    expect(result.committed).toBe(false);
    expect(result.statusCode).toBe(422);
    expect(result.preview.counts).toMatchObject({ update: 1, invalid: 1 });
    expect(result.applied).toEqual([]);
    expect(
      setup.statements.some((statement) => statement.includes("INSERT INTO stock_product")),
    ).toBe(false);
    expect(setup.statements.some((statement) => statement.includes("UPDATE stock_product"))).toBe(
      false,
    );
  });

  it("aplica novas e atualizações válidas, criando entrada/correção no mesmo lote", async () => {
    const content = "Nome\tQuantidade\nArroz\t2\nFeijão\t1";
    const setup = bulkPool();
    const service = new StockService(setup.pool);

    const result = await service.applyBulkProducts(
      scope,
      { content, mode: "valid_only", previewHash: hash(content) },
      "stock-bulk-service-0002",
    );

    expect(result.committed).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.applied).toHaveLength(2);
    expect(result.applied.map((row) => row.action)).toEqual(["update", "new"]);
    expect(
      setup.statements.filter((statement) => statement.includes("INSERT INTO stock_movement")),
    ).toHaveLength(2);
    expect(setup.statements.some((statement) => statement.includes("UPDATE stock_product"))).toBe(
      true,
    );
    expect(
      setup.statements.some((statement) => statement.includes("INSERT INTO stock_product")),
    ).toBe(true);
  });
});
