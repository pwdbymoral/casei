import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CsvExportError,
  canonicalExportJson,
  createVersionedCsvExport,
  DEFAULT_CSV_EXPORT_LIMITS,
  type ExportManifest,
} from "../src/index.js";

async function consumeExport(
  exported: ReturnType<typeof createVersionedCsvExport>,
): Promise<string> {
  const reader = exported.stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function baseOptions() {
  return {
    domain: "transactions",
    schemaVersion: "transactions.v1",
    generatedAt: "2026-08-24T17:30:00.000Z",
    timeZone: "America/Fortaleza",
    currency: "BRL",
    filters: { from: "2026-01-01", to: "2026-01-31", state: "posted" },
    columns: [
      { key: "description", label: "Descrição" },
      { key: "amount_minor", label: "Valor em centavos" },
    ],
    rows: [
      {
        casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
        description: "Mercado",
        amount_minor: "123456",
      },
      {
        casei_id: "0190f93c-4b1e-7abc-8def-0123456789ac",
        description: "Luz",
        amount_minor: "9000",
      },
    ],
  } as const;
}

describe("exportação CSV versionada", () => {
  it("emite cabeçalho canônico com versão e IDs, em UTF-8, sem mutação", async () => {
    const options = baseOptions();
    const exported = createVersionedCsvExport(options);
    const csv = await consumeExport(exported);

    expect(csv).toBe(
      '"casei_schema_version","casei_id","description","amount_minor"\r\n' +
        '"transactions.v1","0190f93c-4b1e-7abc-8def-0123456789ab","Mercado","123456"\r\n' +
        '"transactions.v1","0190f93c-4b1e-7abc-8def-0123456789ac","Luz","9000"\r\n',
    );
    expect(options.rows).toHaveLength(2);
    expect(exported.contentType).toBe("text/csv; charset=utf-8");
    expect(exported.fileName).toBe("transactions.csv");
  });

  it("produz manifesto determinístico com metadados, filtros, contagem e SHA-256 do CSV", async () => {
    const exported = createVersionedCsvExport(baseOptions());
    const csv = await consumeExport(exported);
    const manifest = await exported.manifest;

    expect(manifest).toMatchObject<Partial<ExportManifest>>({
      manifestVersion: "1",
      schemaVersion: "transactions.v1",
      domain: "transactions",
      generatedAt: "2026-08-24T17:30:00.000Z",
      timeZone: "America/Fortaleza",
      currency: "BRL",
      filters: { from: "2026-01-01", to: "2026-01-31", state: "posted" },
    });
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({
      name: "transactions.csv",
      format: "csv",
      rowCount: 2,
      byteLength: new TextEncoder().encode(csv).byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifest.columns).toEqual([
      { key: "casei_schema_version" },
      { key: "casei_id" },
      { key: "description", label: "Descrição" },
      { key: "amount_minor", label: "Valor em centavos" },
    ]);
    expect(await exported.manifestJson).toBe(canonicalExportJson(manifest));
    expect(await exported.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files[0]?.sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode(csv)).digest("hex"),
    );
    expect(await exported.manifestSha256).toBe(
      createHash("sha256")
        .update(await exported.manifestJson)
        .digest("hex"),
    );
  });

  it("mantém chunks abaixo do limite e calcula o mesmo hash ao atravessar células grandes", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      maxChunkBytes: 7,
      rows: [
        {
          casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
          description: "á".repeat(100),
          amount_minor: "1",
        },
      ],
    });
    const reader = exported.stream.getReader();
    let total = 0;
    let chunks = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
      total += next.value.byteLength;
      expect(next.value.byteLength).toBeLessThanOrEqual(7);
    }
    const manifest = await exported.manifest;
    expect(chunks).toBeGreaterThan(2);
    expect(total).toBe(manifest.files[0]?.byteLength);
  });
});

describe("formula injection e manifesto", () => {
  it("prefixa células perigosas e preserva os valores lógicos no manifesto", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: [
        {
          casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
          description: '=HYPERLINK("https://evil")',
          amount_minor: "1",
        },
      ],
    });
    const csv = await consumeExport(exported);
    const manifest = await exported.manifest;

    expect(csv).toContain(`"'=HYPERLINK(""https://evil"")"`);
    expect(manifest.files[0]?.protectedCells).toEqual([
      {
        rowNumber: 1,
        column: "description",
        logicalValue: '=HYPERLINK("https://evil")',
      },
    ]);
  });

  it("não permite desativar a proteção de fórmulas no export versionado", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: [
        {
          casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
          description: '=HYPERLINK("https://evil")',
          amount_minor: "1",
        },
      ],
      protectFormulas: false,
    } as unknown as Parameters<typeof createVersionedCsvExport>[0]);

    const csv = await consumeExport(exported);

    expect(csv).toContain(`"'=HYPERLINK(""https://evil"")"`);
  });
});

describe("limites e falhas seguras da exportação", () => {
  it("usa limites padrão bounded e rejeita schema/metadados perigosos", async () => {
    expect(DEFAULT_CSV_EXPORT_LIMITS).toMatchObject({
      maxRows: 50_000,
      maxBytes: 10_000_000,
      maxChunkBytes: 64 * 1024,
    });
    expect(() => createVersionedCsvExport({ ...baseOptions(), schemaVersion: "" })).toThrowError(
      expect.objectContaining({ code: "invalid_schema" }),
    );
    expect(() =>
      createVersionedCsvExport({ ...baseOptions(), fileName: "../secrets.csv" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_file_name" }));
    expect(() => createVersionedCsvExport({ ...baseOptions(), currency: "brl" })).toThrowError(
      expect.objectContaining({ code: "invalid_metadata" }),
    );
  });

  it("falha por linha sem vazar valores e não resolve manifesto parcialmente", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: [
        {
          casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
          description: "ok",
          amount_minor: "1",
          extra: "não exporte",
        },
      ],
    });
    await expect(consumeExport(exported)).rejects.toMatchObject({ code: "invalid_row" });
    await expect(exported.manifest).rejects.toMatchObject({ code: "invalid_row" });
    await expect(exported.manifest).rejects.not.toThrow("não exporte");
  });

  it("não aceita que a linha substitua a versão controlada pelo exportador", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: [
        {
          casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
          casei_schema_version: "transactions.v0",
          description: "versão falsa",
          amount_minor: "1",
        },
      ],
    });

    await expect(consumeExport(exported)).rejects.toMatchObject({ code: "invalid_row" });
  });

  it("interrompe no limite de linhas e bytes", async () => {
    const tooManyRows = createVersionedCsvExport({
      ...baseOptions(),
      maxRows: 1,
    });
    await expect(consumeExport(tooManyRows)).rejects.toMatchObject({ code: "row_limit_exceeded" });

    const tooLarge = createVersionedCsvExport({
      ...baseOptions(),
      maxBytes: 20,
    });
    await expect(consumeExport(tooLarge)).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("cancela o stream sem confirmar exportação incompleta", async () => {
    const exported = createVersionedCsvExport(baseOptions());
    const reader = exported.stream.getReader();
    await reader.read();
    await reader.cancel("cliente desconectou");
    await expect(exported.manifest).rejects.toMatchObject({ code: "stream_cancelled" });
  });

  it("fecha o iterador da fonte quando o consumidor cancela", async () => {
    let returnCalls = 0;
    let nextCalls = 0;
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: {
        [Symbol.iterator]() {
          let index = 0;
          return {
            next() {
              nextCalls += 1;
              index += 1;
              return {
                done: false,
                value: {
                  casei_id: `0190f93c-4b1e-7abc-8def-0123456789a${index}`,
                  description: "linha",
                  amount_minor: "1",
                },
              };
            },
            return() {
              returnCalls += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });
    const reader = exported.stream.getReader();
    for (let index = 0; index < 16 && nextCalls === 0; index += 1) await reader.read();
    await reader.cancel("cliente desconectou");

    expect(returnCalls).toBe(1);
    await expect(exported.manifest).rejects.toMatchObject({ code: "stream_cancelled" });
  });

  it("fecha o iterador da fonte quando a leitura falha", async () => {
    let returnCalls = 0;
    let nextCalls = 0;
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: {
        [Symbol.iterator]() {
          return {
            next() {
              nextCalls += 1;
              if (nextCalls === 1) {
                return {
                  done: false,
                  value: {
                    casei_id: "0190f93c-4b1e-7abc-8def-0123456789ab",
                    description: "linha",
                    amount_minor: "1",
                  },
                };
              }
              throw new Error("cursor indisponível");
            },
            return() {
              returnCalls += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });

    await expect(consumeExport(exported)).rejects.toMatchObject({ code: "source_failed" });
    expect(returnCalls).toBe(1);
  });

  it("rejeita uma linha sem casei_id para preservar reimportação estável", async () => {
    const exported = createVersionedCsvExport({
      ...baseOptions(),
      rows: [{ description: "sem ID", amount_minor: "1" }],
    });
    await expect(consumeExport(exported)).rejects.toMatchObject({ code: "invalid_row" });
  });
});

describe("erros públicos", () => {
  it("não expõe conteúdo sensível no erro de exportação", () => {
    try {
      createVersionedCsvExport({ ...baseOptions(), fileName: "secret/finance.csv" });
      throw new Error("expected invalid file name");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvExportError);
      expect(error).toMatchObject({ code: "invalid_file_name" });
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
