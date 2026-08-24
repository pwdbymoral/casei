import { describe, expect, it } from "vitest";
import {
  parseStockBulk,
  previewStockBulk,
  type StockBulkExistingProduct,
} from "../src/index.js";

const existing: StockBulkExistingProduct[] = [
  {
    id: "product-feijao",
    name: "Feijão",
    unit: "kg",
    unitLabel: null,
    quantity: "1",
    minimum: "1",
    markedMissing: false,
    shoppingAuto: true,
    category: "Despensa",
    location: "Armário",
    note: null,
    version: 3,
    hasMovement: true,
  },
];

describe("STOCK-004 parser de cadastro em lote", () => {
  it("aceita nomes, remove somente a quebra final e preserva linha vazia para diagnóstico", () => {
    const result = parseStockBulk("Arroz\n\nFeijão\n");

    expect(result.fatalErrors).toEqual([]);
    expect(result.rows.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
    expect(result.rows[0]?.values.name).toBe("Arroz");
    expect(result.rows[1]?.values.name).toBe("");
    expect(result.rows[2]?.values.name).toBe("Feijão");
  });

  it("interpreta colagem tabular com cabeçalhos e valores localizados", () => {
    const result = parseStockBulk(
      "Nome\tUnidade\tQuantidade\tMínimo\tComprar automaticamente\nArroz\tkg\t2.500\t1\tsim",
    );

    expect(result.fatalErrors).toEqual([]);
    expect(result.headers).toEqual([
      "Nome",
      "Unidade",
      "Quantidade",
      "Mínimo",
      "Comprar automaticamente",
    ]);
    expect(result.rows[0]?.values).toMatchObject({
      name: "Arroz",
      unit: "kg",
      quantity: "2.5",
      minimum: "1",
      shoppingAuto: true,
    });
  });

  it("rejeita cabeçalho desconhecido como erro de arquivo e não inventa campo", () => {
    const result = parseStockBulk("Nome\tFornecedor\nArroz\tAcme");

    expect(result.rows).toHaveLength(0);
    expect(result.fatalErrors).toEqual([expect.stringContaining("Fornecedor")]);
  });
});

describe("STOCK-004 prévia", () => {
  it("separa novos, atualizações, duplicatas e erros com mudanças explícitas", () => {
    const result = previewStockBulk(
      "Nome\tQuantidade\tMínimo\nArroz\t2\t1\nFeijão\t3\t1\nFeijão\t3\t1\n\t1\t1",
      existing,
    );

    expect(result.rows.map((row) => row.status)).toEqual([
      "new",
      "update",
      "duplicate",
      "invalid",
    ]);
    expect(result.counts).toEqual({ new: 1, update: 1, duplicate: 1, invalid: 1 });
    expect(result.rows[1]?.changes).toEqual([
      { field: "quantity", before: "1", after: "3" },
    ]);
    expect(result.rows[2]?.errors).toEqual([expect.stringContaining("duplicada")]);
    expect(result.rows[3]?.errors).toEqual([expect.stringContaining("obrigatório")]);
  });

  it("classifica repetição sem mudança como duplicata e mudança de unidade histórica como erro", () => {
    const result = previewStockBulk(
      "Nome\tUnidade\nFeijão\tkg\nFeijão\tg",
      existing,
    );

    expect(result.rows[0]).toMatchObject({ status: "duplicate", existingProductId: "product-feijao" });
    expect(result.rows[1]).toMatchObject({ status: "invalid", existingProductId: "product-feijao" });
    expect(result.rows[1]?.errors).toEqual([expect.stringContaining("unidade")]);
  });
});
