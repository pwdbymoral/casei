import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  type CsvFieldDefinition,
  CsvImportError,
  parseXlsx,
  preflightCsvImport,
} from "../src/index.js";

async function workbookBytes(configure: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function storedZip(entryNames: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const name of entryNames) {
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local);

    const record = new Uint8Array(46 + nameBytes.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(28, nameBytes.length, true);
    recordView.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(...central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entryNames.length, true);
  endView.setUint16(10, entryNames.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  chunks.push(end);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

describe("parser XLSX seguro", () => {
  it("lê uma planilha, preserva fórmulas pelo cache e normaliza números", async () => {
    const input = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Importação");
      sheet.addRow(["Descrição", "Valor", "Data", "Fórmula"]);
      sheet.addRow(["Mercado", 1234.56, new Date("2024-02-01T00:00:00.000Z"), null]);
      sheet.getCell("D2").value = { formula: "B2*2", result: 2469.12 };
    });

    const parsed = await parseXlsx(input, { locale: "pt-BR" });

    expect(parsed.format).toBe("xlsx");
    expect(parsed.sheetName).toBe("Importação");
    expect(parsed.headers).toEqual(["Descrição", "Valor", "Data", "Fórmula"]);
    expect(parsed.rows[0]?.cells).toEqual(["Mercado", "1234,56", "2024-02-01", "2469,12"]);
  });

  it("exige escolha quando há mais de uma planilha e aceita seleção explícita", async () => {
    const input = await workbookBytes((workbook) => {
      workbook.addWorksheet("Primeira").addRow(["valor"]);
      workbook.addWorksheet("Segunda").addRow(["valor"]);
    });

    await expect(parseXlsx(input)).rejects.toMatchObject({
      code: "sheet_selection_required",
    });
    await expect(parseXlsx(input, { sheetName: "Segunda" })).resolves.toMatchObject({
      sheetName: "Segunda",
      headers: ["valor"],
    });
  });

  it("rejeita macro, link externo, arquivo inválido e limites antes do load", async () => {
    await expect(parseXlsx(storedZip(["xl/vbaProject.bin"]))).rejects.toMatchObject({
      code: "macro_detected",
    });
    await expect(
      parseXlsx(storedZip(["xl/externalLinks/externalLink1.xml"])),
    ).rejects.toMatchObject({
      code: "external_link_detected",
    });
    await expect(parseXlsx(Uint8Array.from([1, 2, 3]))).rejects.toMatchObject({
      code: "invalid_xlsx",
    });
  });

  it("impõe limite de linhas, células e bytes descompactados", async () => {
    const input = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Dados");
      sheet.addRow(["valor"]);
      sheet.addRow(["primeira"]);
      sheet.addRow(["segunda"]);
    });

    await expect(parseXlsx(input, { maxRows: 1 })).rejects.toMatchObject({
      code: "row_limit_exceeded",
    });
    await expect(parseXlsx(input, { maxCellBytes: 3 })).rejects.toMatchObject({
      code: "cell_too_large",
    });
    await expect(parseXlsx(input, { maxUncompressedBytes: 1 })).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("alimenta o mesmo preflight por linha do CSV", async () => {
    const input = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Dados");
      sheet.addRow(["Descrição", "Valor"]);
      sheet.addRow(["Mercado", "10,00"]);
      sheet.addRow(["", "20,00"]);
    });
    const parsed = await parseXlsx(input, { locale: "pt-BR" });
    const fields: readonly CsvFieldDefinition<string>[] = [
      { key: "description", aliases: ["descrição"], required: true },
      { key: "amount", aliases: ["valor"], required: true },
    ];

    const result = preflightCsvImport(parsed, fields);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ status: "valid", rowNumber: 2 });
    expect(result.rows[1]).toMatchObject({ status: "invalid", rowNumber: 3 });
    expect(result.rows[1]?.errors).toEqual([
      expect.objectContaining({ code: "required", field: "description" }),
    ]);
  });

  it("não confunde fórmula sem cache com um valor importável", async () => {
    const input = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Dados");
      sheet.addRow(["valor"]);
      sheet.getCell("A2").value = { formula: "1+1" };
    });

    await expect(parseXlsx(input)).rejects.toBeInstanceOf(CsvImportError);
    await expect(parseXlsx(input)).rejects.toMatchObject({
      code: "formula_without_cached_value",
    });
  });
});
