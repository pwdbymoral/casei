import { describe, expect, it } from "vitest";

import { createVersionedCsvExport, createVersionedZipBundleExport } from "../src/index.js";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("bundle export", () => {
  it("contains each domain CSV and a manifest with their checksums", async () => {
    const common = {
      schemaVersion: "1",
      generatedAt: "2026-09-03T12:00:00.000Z",
      timeZone: "America/Fortaleza",
      currency: "BRL",
      filters: {},
      columns: [{ key: "name" }],
    } as const;
    const products = createVersionedCsvExport({
      ...common,
      domain: "products",
      fileName: "products.csv",
      rows: [{ casei_id: "product-1", name: "Arroz" }],
    });
    const transactions = createVersionedCsvExport({
      ...common,
      domain: "transactions",
      fileName: "transactions.csv",
      rows: [{ casei_id: "transaction-1", name: "Mercado" }],
    });
    const bundle = createVersionedZipBundleExport({
      files: [products, transactions],
      zipFileName: "casei-completo.zip",
      schemaVersion: "1",
      domain: "complete",
      generatedAt: common.generatedAt,
      timeZone: common.timeZone,
      currency: common.currency,
      filters: common.filters,
    });

    const output = await bytes(bundle.stream);
    const archive = new TextDecoder().decode(output);
    const manifest = await bundle.manifest;
    expect(bundle.contentType).toBe("application/zip");
    expect(output.slice(0, 4)).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    expect(archive).toContain("products.csv");
    expect(archive).toContain("transactions.csv");
    expect(archive).toContain("manifest.json");
    expect(manifest.files.map((file) => file.name)).toEqual(["products.csv", "transactions.csv"]);
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
  });
});
