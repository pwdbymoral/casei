import { describe, expect, it } from "vitest";

import {
  canExportData,
  canImportData,
  dataExchangeAdapterForEnvironment,
  dataFieldsForDomain,
  detectPreviewDelimiter,
  formatDataFileSize,
  inferMapping,
  parseLocalCsvPreview,
} from "./data-exchange";

describe("data exchange UI ports", () => {
  it("infere o separador pt-BR e preserva campos desconhecidos como aviso", () => {
    const preview = parseLocalCsvPreview(
      "Tipo;Valor;Data;Observação\ndespesa;10,00;2026-08-25;mercado",
      { domain: "transactions", locale: "pt-BR" },
    );

    expect(detectPreviewDelimiter("Tipo;Valor;Data", "pt-BR")).toBe(";");
    expect(preview.mapping).toMatchObject({ type: "Tipo", amount: "Valor", date: "Data" });
    expect(preview.unknownHeaders).toEqual(["Observação"]);
    expect(preview.counts).toEqual({ valid: 1, warnings: 1, duplicates: 0, errors: 0 });
    expect(preview.canConfirm).toBe(true);
  });

  it("marca linha inválida quando campo obrigatório não foi preenchido", () => {
    const preview = parseLocalCsvPreview("Nome;Quantidade\n;2\nArroz;1", {
      domain: "products",
      locale: "pt-BR",
    });

    expect(preview.rows[0]).toMatchObject({ rowNumber: 2, status: "invalid" });
    expect(preview.rows[0]?.errors).toContain("Nome é obrigatório.");
    expect(preview.counts.errors).toBe(1);
    expect(preview.canConfirm).toBe(false);
  });

  it("sinaliza linhas repetidas como duplicatas sugeridas, sem bloqueio implícito", () => {
    const preview = parseLocalCsvPreview(
      "Tipo;Valor;Data\ndespesa;10,00;2026-08-25\ndespesa;10,00;2026-08-25",
      { domain: "transactions", locale: "pt-BR" },
    );

    expect(preview.rows[1]?.status).toBe("duplicate");
    expect(preview.counts).toMatchObject({ valid: 1, duplicates: 1, errors: 0 });
    expect(preview.canConfirm).toBe(true);
  });

  it("permite mapeamento explícito e informa campos obrigatórios ausentes", () => {
    const fields = dataFieldsForDomain("transactions");
    const mapping = inferMapping(["kind", "total"], fields, { amount: "total" });

    expect(mapping.mapping).toEqual({ type: "kind", amount: "total" });
    expect(mapping.missingRequired).toEqual(["date"]);
    expect(mapping.unknownHeaders).toEqual([]);
  });

  it("mantém a política de permissão no boundary da UI", () => {
    expect(canImportData("owner")).toBe(true);
    expect(canImportData("member")).toBe(true);
    expect(canImportData("viewer")).toBe(false);
    expect(canExportData("viewer")).toBe(true);
    expect(formatDataFileSize(10_000_000)).toBe("9.5 MB");
  });

  it("exercita o port de fixture sem prometer persistência no servidor", async () => {
    const adapter = dataExchangeAdapterForEnvironment({ fixtures: true });
    const file = new File(["Tipo;Valor;Data\ndespesa;10,00;2026-08-25"], "movimentos.csv", {
      type: "text/csv",
    });
    const preview = await adapter.previewImport("workspace-1", {
      file,
      domain: "transactions",
      locale: "pt-BR",
    });
    expect(preview.serverBacked).toBe(false);
    expect(preview.canConfirm).toBe(true);

    let job = await adapter.startImport(
      "workspace-1",
      {
        preview,
        file,
        mapping: preview.mapping,
        duplicatePolicy: "ignore",
        applyMode: "valid_only",
      },
      "idempotency-1",
    );
    for (let index = 0; index < 3 && job.status === "processing"; index += 1) {
      job = await adapter.getImportJob("workspace-1", job.id);
    }
    expect(job.status).toBe("completed");
    expect(job.appliedRows).toBe(1);
  });
});
