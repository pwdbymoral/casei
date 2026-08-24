import { describe, expect, it } from "vitest";

import {
  CsvImportError,
  DEFAULT_CSV_LIMITS,
  detectCsvDelimiter,
  fingerprintImportRow,
  mapCsvColumns,
  normalizeHeader,
  normalizeImportValue,
  parseCsv,
  parseCsvDate,
  parseMinorAmount,
  preflightCsvImport,
  protectCsvFormula,
  serializeCsv,
} from "../src/index.js";

describe("parser CSV seguro", () => {
  it("lê UTF-8 com BOM, aspas, vírgulas e quebras de linha dentro de célula", () => {
    const csv = '\ufeffDescrição;Valor\r\n"Mercado; feira";"1.234,56"\r\n"Nota\nlonga";10,00\r\n';

    const parsed = parseCsv(new TextEncoder().encode(csv));

    expect(parsed.encoding).toBe("utf-8");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Descrição", "Valor"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.cells).toEqual(["Mercado; feira", "1.234,56"]);
    expect(parsed.rows[1]?.cells).toEqual(["Nota\nlonga", "10,00"]);
  });

  it("detecta Latin-1 quando UTF-8 estrito não é possível", () => {
    const latin1 = Uint8Array.from([
      0x6e, 0x6f, 0x6d, 0x65, 0x3b, 0x70, 0x65, 0x73, 0x73, 0x6f, 0x61, 0x0a, 0x6a, 0x6f, 0x73,
      0xe9, 0x3b, 0x31, 0x0a,
    ]);

    const parsed = parseCsv(latin1);

    expect(parsed.encoding).toBe("latin1");
    expect(parsed.rows[0]?.cells[0]).toBe("josé");
  });

  it("rejeita UTF-16/binary e aspas não fechadas sem coerção silenciosa", () => {
    expect(() => parseCsv(Uint8Array.from([0xff, 0xfe, 0x61, 0x00]))).toThrowError(
      expect.objectContaining({ code: "unsupported_encoding" }),
    );
    expect(() => parseCsv('a;b\n"sem fim;b\n')).toThrowError(
      expect.objectContaining({ code: "malformed_csv" }),
    );
    expect(() => parseCsv('a;b\n"ok"sobrou;b\n')).toThrowError(
      expect.objectContaining({ code: "malformed_csv", rowNumber: 2 }),
    );
  });

  it("impõe limite de bytes e linhas antes de devolver uma prévia", () => {
    expect(DEFAULT_CSV_LIMITS.maxBytes).toBe(10_000_000);
    expect(() => parseCsv("a\n1\n2\n", { maxRows: 1 })).toThrowError(
      expect.objectContaining({ code: "row_limit_exceeded", rowNumber: 3 }),
    );
    expect(() => parseCsv("a\n12345", { maxBytes: 5 })).toThrowError(
      expect.objectContaining({ code: "file_too_large" }),
    );
  });

  it("detecta separadores comuns fora de campos citados", () => {
    expect(detectCsvDelimiter('a,"b,c"\n1,"2,3"')).toBe(",");
    expect(detectCsvDelimiter("a;b\n1;2")).toBe(";");
    expect(detectCsvDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(parseCsv("Valor\n10,00", { locale: "pt-BR" }).rows[0]?.cells).toEqual(["10,00"]);
  });

  it("preserva cabeçalho original, normaliza acentos e rejeita cabeçalhos duplicados", () => {
    expect(normalizeHeader("  Descrição do cartão  ")).toBe("descricao do cartao");
    expect(normalizeHeader("casei_id")).toBe("casei id");
    expect(() => parseCsv("Descrição;descricao\nA;B")).toThrowError(
      expect.objectContaining({ code: "duplicate_header" }),
    );
  });
});

describe("normalização localizada e mapeamento", () => {
  it("interpreta datas pt-BR/en-US somente com calendário real", () => {
    expect(parseCsvDate("29/02/2024", "pt-BR")).toBe("2024-02-29");
    expect(parseCsvDate("02/29/2024", "en-US")).toBe("2024-02-29");
    expect(() => parseCsvDate("31/02/2024", "pt-BR")).toThrowError(
      expect.objectContaining({ code: "invalid_date" }),
    );
    expect(() => parseCsvDate("01/02/2024", undefined)).toThrowError(
      expect.objectContaining({ code: "ambiguous_locale" }),
    );
  });

  it("converte valores monetários sem float e rejeita agrupamento ambíguo", () => {
    expect(parseMinorAmount("R$ 1.234,56", "pt-BR")).toBe("123456");
    expect(parseMinorAmount("-12,50", "pt-BR")).toBe("-1250");
    expect(parseMinorAmount("1,234.56", "en-US")).toBe("123456");
    expect(() => parseMinorAmount("1.234,567", "pt-BR")).toThrowError(
      expect.objectContaining({ code: "invalid_amount" }),
    );
    expect(() => parseMinorAmount("1.2.34", "pt-BR")).toThrowError(
      expect.objectContaining({ code: "invalid_amount" }),
    );
  });

  it("sugere mapeamento editável e explicita campos desconhecidos/obrigatórios", () => {
    const result = mapCsvColumns(
      ["Descrição", "Valor", "Banco estranho"],
      [
        { key: "description", aliases: ["descrição"], required: true },
        { key: "amount", aliases: ["valor", "amount"], required: true },
        { key: "occurredOn", aliases: ["data"] },
      ],
    );

    expect(result.mapping).toEqual({ description: "Descrição", amount: "Valor" });
    expect(result.unknownHeaders).toEqual(["Banco estranho"]);
    expect(result.missingRequired).toEqual([]);

    const missing = mapCsvColumns(
      ["Banco estranho"],
      [{ key: "amount", aliases: ["valor"], required: true }],
    );
    expect(missing.missingRequired).toEqual(["amount"]);
  });

  it("permite mapeamento manual e rejeita dois campos usando a mesma coluna", () => {
    const result = mapCsvColumns(
      ["Valor", "Data"],
      [
        { key: "amount", aliases: ["valor"], required: true },
        { key: "otherAmount", aliases: ["outro"], required: true },
      ],
      { otherAmount: "Valor" },
    );

    expect(result.mapping).toEqual({ amount: "Valor", otherAmount: "Valor" });
    expect(result.mappingErrors).toEqual([
      expect.objectContaining({ code: "duplicate_mapping", field: "otherAmount" }),
    ]);

    const automaticCollision = mapCsvColumns(
      ["Valor"],
      [
        { key: "amount", aliases: ["valor"] },
        { key: "otherAmount", aliases: ["valor"] },
      ],
    );
    expect(automaticCollision.mappingErrors).toEqual([
      expect.objectContaining({ code: "duplicate_mapping", field: "otherAmount" }),
    ]);
  });

  it("normaliza fingerprint de domínio sem tratar coincidência como exclusão automática", () => {
    const first = fingerprintImportRow("transactions", {
      occurredOn: "2024-02-01",
      description: "  Mercado  ",
      amount: "123456",
    });
    const same = fingerprintImportRow("transactions", {
      occurredOn: "2024-02-01",
      description: "mercado",
      amount: "123456",
    });
    const different = fingerprintImportRow("transactions", {
      occurredOn: "2024-02-01",
      description: "mercado",
      amount: "123457",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(different).not.toBe(first);
    expect(
      fingerprintImportRow(
        "transactions",
        { occurredOn: "2024-02-01", description: "mercado", amount: "123456" },
        { fields: ["amount", "description", "occurredOn"] },
      ),
    ).toBe(first);
  });
});

describe("preflight por linha", () => {
  const fields = [
    {
      key: "description",
      aliases: ["descrição"],
      required: true,
      parse: (value: string) => normalizeImportValue(value),
    },
    {
      key: "amount",
      aliases: ["valor"],
      required: true,
      parse: (value: string) => parseMinorAmount(value, "pt-BR"),
    },
    {
      key: "occurredOn",
      aliases: ["data"],
      required: true,
      parse: (value: string) => parseCsvDate(value, "pt-BR"),
    },
  ] as const;

  it("valida cada linha, classifica erros/avisos/duplicatas e não muta entrada", () => {
    const parsed = parseCsv(
      "Descrição;Valor;Data;Coluna nova\nMercado;R$ 10,00;01/02/2024;x\n;R$ errado;31/02/2024;y\nMercado;10,00;01/02/2024;z",
    );
    const before = parsed.rows.map((row) => [...row.cells]);

    const result = preflightCsvImport(parsed, fields, {
      fingerprint: { domain: "transactions", fields: ["description", "amount", "occurredOn"] },
      existingFingerprints: new Set(),
      unknownColumns: "warning",
    });

    expect(result.unknownHeaders).toEqual(["Coluna nova"]);
    expect(result.rows[0]).toMatchObject({ status: "valid", fingerprint: expect.any(String) });
    expect(result.rows[1]?.status).toBe("invalid");
    expect(result.rows[1]?.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["required", "invalid_amount", "invalid_date"]),
    );
    expect(result.rows[2]).toMatchObject({
      status: "duplicate",
      fingerprint: result.rows[0]?.fingerprint,
    });
    expect(result.counts).toEqual({ valid: 1, warnings: 1, duplicates: 1, errors: 1 });
    expect(parsed.rows.map((row) => row.cells)).toEqual(before);
  });

  it("pode tornar coluna desconhecida um erro sem descartar a informação", () => {
    const parsed = parseCsv("Valor;Extra\n10,00;ok");
    const result = preflightCsvImport(
      parsed,
      [{ key: "amount", aliases: ["valor"], required: true, parse: (value: string) => value }],
      { unknownColumns: "error" },
    );

    expect(result.unknownHeaders).toEqual(["Extra"]);
    expect(result.mappingErrors).toEqual([
      expect.objectContaining({ code: "unknown_column", header: "Extra" }),
    ]);
    expect(result.canConfirm).toBe(false);
  });

  it("marca fingerprint já existente como sugestão de duplicata, sem invalidar a linha", () => {
    const parsed = parseCsv("Valor\n10,00", { locale: "pt-BR" });
    const existing = fingerprintImportRow(
      "transactions",
      { amount: "1000" },
      { fields: ["amount"] },
    );
    const result = preflightCsvImport(
      parsed,
      [
        {
          key: "amount",
          aliases: ["valor"],
          required: true,
          parse: (value: string) => parseMinorAmount(value, "pt-BR"),
        },
      ],
      {
        fingerprint: { domain: "transactions", fields: ["amount"] },
        existingFingerprints: new Set([existing]),
      },
    );

    expect(result.rows[0]).toMatchObject({ status: "duplicate", errors: [] });
    expect(result.canConfirm).toBe(true);
  });
});

describe("proteção de exportação CSV", () => {
  it("prefixa valores que podem ser interpretados como fórmula e mantém valor lógico", () => {
    expect(protectCsvFormula("=1+1")).toEqual({
      value: "'=1+1",
      logicalValue: "=1+1",
      formulaProtected: true,
    });
    expect(protectCsvFormula(" seguro ")).toEqual({
      value: " seguro ",
      logicalValue: " seguro ",
      formulaProtected: false,
    });
  });

  it("serializa CSV RFC4180 com proteção por célula, sem executar valores", () => {
    const result = serializeCsv(
      [
        ["Descrição", "Valor"],
        ['=HYPERLINK("https://evil")', "1000"],
      ],
      { protectFormulas: true },
    );

    expect(result).toBe('"Descrição","Valor"\r\n"\'=HYPERLINK(""https://evil"")","1000"\r\n');
  });

  it("protege fórmulas precedidas por whitespace e rejeita célula/valor excessivos", () => {
    expect(protectCsvFormula("\t@cmd").formulaProtected).toBe(true);
    expect(() => parseCsv("a\n1234", { maxCellBytes: 3 })).toThrowError(
      expect.objectContaining({ code: "cell_too_large" }),
    );
    expect(() => parseCsv("a;b;c\n1;2;3", { maxColumns: 2 })).toThrowError(
      expect.objectContaining({ code: "column_limit_exceeded" }),
    );
    expect(() => parseMinorAmount("9999999999999999", "pt-BR")).toThrowError(
      expect.objectContaining({ code: "invalid_amount" }),
    );
  });
});

describe("erros públicos", () => {
  it("expõe código e posição segura sem stack/entrada completa", () => {
    try {
      parseCsv('a;b\n"incompleto', { maxRows: 10 });
      throw new Error("expected parser to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvImportError);
      expect(error).toMatchObject({ code: "malformed_csv", rowNumber: 2 });
      expect((error as Error).message).not.toContain("incompleto");
      expect((error as Error & { stack?: string }).stack).toBeDefined();
    }
  });
});
