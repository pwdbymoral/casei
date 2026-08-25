import { describe, expect, it } from "vitest";

import {
  canExportData,
  canImportData,
  dataExchangeAdapterForEnvironment,
  dataFieldsForDomain,
  detectPreviewDelimiter,
  formatDataFileSize,
  inferMapping,
  MAX_IMPORT_ROWS,
  parseLocalCsvPreview,
  serializeImportErrorReport,
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
    expect(preview.canConfirm).toBe(true);
  });

  it("mantém as 101 linhas da prévia local e permite somente as válidas", () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      index === 100 ? "despesa;10,00;" : `despesa;${index + 1},00;2026-08-25`,
    ).join("\n");
    const preview = parseLocalCsvPreview(`Tipo;Valor;Data\n${rows}`, {
      domain: "transactions",
      locale: "pt-BR",
    });

    expect(preview.rows).toHaveLength(101);
    expect(preview.counts).toMatchObject({ valid: 100, errors: 1 });
    expect(preview.canConfirm).toBe(true);
    expect(preview.rowLimitExceeded).toBe(false);
  });

  it("recusa mais que 50 mil linhas sem declarar a prévia como completa", () => {
    const rows = Array.from(
      { length: MAX_IMPORT_ROWS + 1 },
      (_, index) => `despesa;${index + 1},00;2026-08-25`,
    ).join("\n");
    const preview = parseLocalCsvPreview(`Tipo;Valor;Data\n${rows}`, {
      domain: "transactions",
      locale: "pt-BR",
    });

    expect(preview.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(preview.rowLimitExceeded).toBe(true);
    expect(preview.canConfirm).toBe(false);
    expect(preview.message).toContain("50.000");
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

  it("permite lote misto em valid_only, mas exige zero erros em all_or_nothing", async () => {
    const adapter = dataExchangeAdapterForEnvironment({ fixtures: true });
    const file = new File(
      ["Tipo;Valor;Data\ndespesa;10,00;2026-08-25\ndespesa;20,00;"],
      "misto.csv",
      { type: "text/csv" },
    );
    const preview = await adapter.previewImport("workspace-mixed", {
      file,
      domain: "transactions",
      locale: "pt-BR",
    });
    expect(preview.canConfirm).toBe(true);
    expect(preview.counts).toMatchObject({ valid: 1, errors: 1 });

    const job = await adapter.startImport(
      "workspace-mixed",
      {
        preview,
        file,
        mapping: preview.mapping,
        duplicatePolicy: "ignore",
        applyMode: "valid_only",
      },
      "mixed-valid-only",
    );
    expect(job.status).toBe("processing");
    await expect(
      adapter.startImport(
        "workspace-mixed",
        {
          preview,
          file,
          mapping: preview.mapping,
          duplicatePolicy: "ignore",
          applyMode: "all_or_nothing",
        },
        "mixed-all-or-nothing",
      ),
    ).rejects.toThrow("Tudo ou nada");
  });

  it("isola jobs de fixtures por espaço e reproduz chaves idempotentes", async () => {
    const adapter = dataExchangeAdapterForEnvironment({ fixtures: true });
    const file = new File(["Tipo;Valor;Data\ndespesa;10,00;2026-08-25"], "idempotente.csv", {
      type: "text/csv",
    });
    const preview = await adapter.previewImport("workspace-isolated", {
      file,
      domain: "transactions",
      locale: "pt-BR",
    });
    const first = await adapter.startImport(
      "workspace-isolated",
      {
        preview,
        file,
        mapping: preview.mapping,
        duplicatePolicy: "ignore",
        applyMode: "valid_only",
      },
      "same-key",
    );
    const replay = await adapter.startImport(
      "workspace-isolated",
      {
        preview,
        file,
        mapping: preview.mapping,
        duplicatePolicy: "ignore",
        applyMode: "valid_only",
      },
      "same-key",
    );
    expect(replay.id).toBe(first.id);
    await expect(adapter.getImportJob("other-workspace", first.id)).rejects.toMatchObject({
      code: "permission",
    });
    await expect(
      adapter.retryImport("other-workspace", first.id, "other-retry"),
    ).rejects.toMatchObject({
      code: "permission",
    });
    await expect(adapter.cancelImport("other-workspace", first.id)).rejects.toMatchObject({
      code: "permission",
    });

    const exportJob = await adapter.createExport(
      "workspace-export",
      { domain: "transactions", format: "csv" },
      "export-key",
    );
    const exportReplay = await adapter.createExport(
      "workspace-export",
      { domain: "transactions", format: "csv" },
      "export-key",
    );
    expect(exportReplay.id).toBe(exportJob.id);
    await expect(adapter.getExportJob("other-workspace", exportJob.id)).rejects.toMatchObject({
      code: "permission",
    });
    await adapter.getExportJob("workspace-export", exportJob.id);
    const completedExport = await adapter.getExportJob("workspace-export", exportJob.id);
    expect(completedExport.status).toBe("completed");
    await expect(adapter.downloadExport("other-workspace", exportJob.id)).rejects.toMatchObject({
      code: "permission",
    });

    const duplicateFile = new File(
      ["Tipo;Valor;Data\ndespesa;10,00;2026-08-25\ndespesa;10,00;2026-08-25"],
      "duplicada.csv",
      { type: "text/csv" },
    );
    const duplicatePreview = await adapter.previewImport("workspace-review", {
      file: duplicateFile,
      domain: "transactions",
      locale: "pt-BR",
    });
    const review = await adapter.startImport(
      "workspace-review",
      {
        preview: duplicatePreview,
        file: duplicateFile,
        mapping: duplicatePreview.mapping,
        duplicatePolicy: "review",
        applyMode: "valid_only",
      },
      "review-key",
    );
    expect(review.status).toBe("failed");
    expect(review.appliedRows).toBe(0);
    const reviewRetry = await adapter.retryImport("workspace-review", review.id, "review-retry");
    expect(reviewRetry.id).toBe(review.id);
  });

  it("protege mensagens do relatório contra formula injection", () => {
    expect(serializeImportErrorReport([{ rowNumber: 2, message: '=HYPERLINK("x")' }])).toBe(
      'linha,mensagem\n2,"\'=HYPERLINK(""x"")"',
    );
  });
});
