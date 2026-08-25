import { describe, expect, it, vi } from "vitest";

import {
  beginDataExchangeOperation,
  canExportData,
  canImportData,
  dataExchangeAdapterForEnvironment,
  dataFieldsForDomain,
  detectPreviewDelimiter,
  exportHistorySurfaceStatus,
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

  it("mantém aspas, separadores e quebras de linha dentro de uma célula CSV", () => {
    const preview = parseLocalCsvPreview(
      'Tipo;Valor;Data;Descrição\n"despesa";10,00;2026-08-25;"Mercado; feira\nperto de casa"',
      { domain: "transactions", locale: "pt-BR" },
    );

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.cells).toEqual([
      "despesa",
      "10,00",
      "2026-08-25",
      "Mercado; feira\nperto de casa",
    ]);
    expect(preview.rows[0]?.status).toBe("valid");
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

  it("preserva o estado de permissão no histórico de exportações", () => {
    expect(exportHistorySurfaceStatus("permission", false)).toBe("permission");
    expect(exportHistorySurfaceStatus("success", false)).toBe("empty");
  });

  it("ignora duplo clique de retry e export enquanto o adapter deferred está pendente", async () => {
    let resolveRetry!: (value: string) => void;
    const retryDeferred = new Promise<string>((resolve) => {
      resolveRetry = resolve;
    });
    const retryAdapter = { retryImport: vi.fn((_key: string) => retryDeferred) };
    const retryState = { pending: false, key: null as string | null };
    const firstRetry = beginDataExchangeOperation(
      retryState,
      "retry",
      () => "stable-retry",
      (key) => retryAdapter.retryImport(key),
    );
    const duplicateRetry = beginDataExchangeOperation(
      retryState,
      "retry",
      () => "different-retry",
      (key) => retryAdapter.retryImport(key),
    );

    if (!firstRetry.started) throw new Error("retry operation did not start");
    expect(firstRetry.started).toBe(true);
    expect(duplicateRetry.started).toBe(false);
    expect(duplicateRetry.key).toBe(firstRetry.key);
    expect(retryAdapter.retryImport).toHaveBeenCalledTimes(1);
    resolveRetry("retried");
    await expect(firstRetry.promise).resolves.toBe("retried");
    expect(retryState).toEqual({ pending: false, key: null });

    let resolveExport!: (value: string) => void;
    const exportDeferred = new Promise<string>((resolve) => {
      resolveExport = resolve;
    });
    const exportAdapter = { createExport: vi.fn((_key: string) => exportDeferred) };
    const exportState = { pending: false, key: null as string | null };
    const firstExport = beginDataExchangeOperation(
      exportState,
      "export",
      () => "stable-export",
      (key) => exportAdapter.createExport(key),
    );
    const duplicateExport = beginDataExchangeOperation(
      exportState,
      "export",
      () => "different-export",
      (key) => exportAdapter.createExport(key),
    );

    if (!firstExport.started) throw new Error("export operation did not start");
    expect(duplicateExport.started).toBe(false);
    expect(duplicateExport.key).toBe(firstExport.key);
    expect(exportAdapter.createExport).toHaveBeenCalledTimes(1);
    resolveExport("exported");
    await expect(firstExport.promise).resolves.toBe("exported");
    expect(exportState).toEqual({ pending: false, key: null });
  });

  it("exige uma nova prévia server-backed depois de revisar CSV offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const adapter = dataExchangeAdapterForEnvironment();
      const file = new File(["Tipo;Valor;Data\ndespesa;10,00;2026-08-25"], "offline.csv", {
        type: "text/csv",
      });
      const preview = await adapter.previewImport("workspace-reconnect", {
        file,
        domain: "transactions",
        locale: "pt-BR",
      });
      expect(preview.serverBacked).toBe(false);

      vi.stubGlobal("navigator", { onLine: true });
      await expect(
        adapter.startImport(
          "workspace-reconnect",
          {
            preview,
            file,
            mapping: preview.mapping,
            duplicatePolicy: "ignore",
            applyMode: "valid_only",
          },
          "reconnect-key",
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      vi.unstubAllGlobals();
    }
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
    await expect(
      adapter.startImport(
        "workspace-isolated",
        {
          preview,
          file,
          mapping: preview.mapping,
          duplicatePolicy: "import",
          applyMode: "valid_only",
        },
        "same-key",
      ),
    ).rejects.toThrow("outro payload");
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
    await expect(
      adapter.createExport("workspace-export", { domain: "products", format: "csv" }, "export-key"),
    ).rejects.toThrow("outro payload");
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

    const secondImport = await adapter.startImport(
      "workspace-isolated",
      {
        preview,
        file,
        mapping: preview.mapping,
        duplicatePolicy: "ignore",
        applyMode: "valid_only",
      },
      "second-key",
    );
    await adapter.retryImport("workspace-isolated", first.id, "same-retry-key");
    await expect(
      adapter.retryImport("workspace-isolated", secondImport.id, "same-retry-key"),
    ).rejects.toThrow("outro payload");
  });

  it("protege mensagens do relatório contra formula injection", () => {
    expect(serializeImportErrorReport([{ rowNumber: 2, message: '=HYPERLINK("x")' }])).toBe(
      'linha,mensagem\n2,"\'=HYPERLINK(""x"")"',
    );
  });
});
