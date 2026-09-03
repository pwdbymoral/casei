import { createHash } from "node:crypto";

import {
  CsvExportError,
  canonicalExportJson,
  type ExportFileManifest,
  type ExportJsonValue,
  type VersionedCsvExport,
} from "./export.js";

export interface VersionedZipBundleExportOptions {
  readonly files: readonly VersionedCsvExport[];
  readonly zipFileName: string;
  readonly schemaVersion: string;
  readonly domain: string;
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly filters: ExportJsonValue;
  readonly maxBytes?: number;
}

export interface ExportBundleManifest {
  readonly manifestVersion: "1";
  readonly schemaVersion: string;
  readonly domain: string;
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly currency: string;
  readonly filters: ExportJsonValue;
  readonly files: readonly ExportFileManifest[];
}

export interface VersionedZipBundleExport {
  readonly stream: ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly contentType: "application/zip";
  readonly manifest: Promise<ExportBundleManifest>;
  readonly manifestJson: Promise<string>;
  readonly manifestSha256: Promise<string>;
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_FLAGS = 0x0808;
const ZIP_MAX_UINT32 = 0xffffffff;
const DEFAULT_MAX_BYTES = 10_000_000;

interface EntryStats {
  readonly name: Uint8Array;
  readonly crc32: number;
  readonly size: number;
  readonly localOffset: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return value >>> 0;
}

function finishCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function ensureZip32(value: number): void {
  if (!Number.isSafeInteger(value) || value > ZIP_MAX_UINT32) {
    throw new CsvExportError("file_too_large", "O arquivo ZIP excede o limite do formato.");
  }
}

function validateZipName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip$/u.test(value) || value.includes("..")) {
    throw new CsvExportError("invalid_file_name", "O nome do arquivo de exportação é inválido.");
  }
  return value;
}

function localHeader(name: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  u32(view, 0, ZIP_LOCAL_SIGNATURE);
  u16(view, 4, 20);
  u16(view, 6, ZIP_DATA_DESCRIPTOR_FLAGS);
  u16(view, 8, 0);
  u16(view, 26, name.byteLength);
  bytes.set(name, 30);
  return bytes;
}

function descriptor(entry: EntryStats): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  u32(view, 0, ZIP_DESCRIPTOR_SIGNATURE);
  u32(view, 4, entry.crc32);
  u32(view, 8, entry.size);
  u32(view, 12, entry.size);
  return bytes;
}

function centralHeader(entry: EntryStats): Uint8Array {
  const bytes = new Uint8Array(46 + entry.name.byteLength);
  const view = new DataView(bytes.buffer);
  u32(view, 0, ZIP_CENTRAL_SIGNATURE);
  u16(view, 4, 20);
  u16(view, 6, 20);
  u16(view, 8, ZIP_DATA_DESCRIPTOR_FLAGS);
  u16(view, 10, 0);
  u16(view, 28, entry.name.byteLength);
  u32(view, 16, entry.crc32);
  u32(view, 20, entry.size);
  u32(view, 24, entry.size);
  u32(view, 42, entry.localOffset);
  bytes.set(entry.name, 46);
  return bytes;
}

function endRecord(count: number, centralSize: number, centralOffset: number): Uint8Array {
  ensureZip32(centralSize);
  ensureZip32(centralOffset);
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  u32(view, 0, ZIP_END_SIGNATURE);
  u16(view, 8, count);
  u16(view, 10, count);
  u32(view, 12, centralSize);
  u32(view, 16, centralOffset);
  return bytes;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Composes already versioned CSV streams into one bounded, stored ZIP. */
export function createVersionedZipBundleExport(
  options: VersionedZipBundleExportOptions,
): VersionedZipBundleExport {
  if (!Array.isArray(options.files) || options.files.length < 1 || options.files.length > 16) {
    throw new CsvExportError("invalid_schema", "O pacote precisa conter entre 1 e 16 arquivos.");
  }
  const fileName = validateZipName(options.zipFileName);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new CsvExportError("file_too_large", "O limite da exportação é inválido.");
  }
  const names = new Set<string>();
  for (const file of options.files) {
    if (names.has(file.fileName)) {
      throw new CsvExportError("invalid_file_name", "O pacote contém nomes de arquivo duplicados.");
    }
    names.add(file.fileName);
  }
  let resolveManifest!: (manifest: ExportBundleManifest) => void;
  let rejectManifest!: (error: CsvExportError) => void;
  const manifest = new Promise<ExportBundleManifest>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });
  const manifestJson = manifest.then((value) => canonicalExportJson(value));
  const manifestSha256 = manifestJson.then(sha256);
  void manifestJson.catch(() => undefined);
  void manifestSha256.catch(() => undefined);

  let currentReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let currentIndex = 0;
  let currentStats: EntryStats | undefined;
  let currentCrc = 0xffffffff;
  let currentSize = 0;
  let archiveOffset = 0;
  const entries: EntryStats[] = [];
  let stage: "file" | "descriptor" | "manifest" | "central" | "done" = "file";
  let manifestReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let manifestBytes: Uint8Array | undefined;
  let manifestStats: EntryStats | undefined;
  let centralEntries: Uint8Array[] | undefined;
  let centralOffset = 0;
  let totalBytes = 0;
  let settled = false;
  let bundleManifest: ExportBundleManifest | undefined;

  const fail = (error: unknown): CsvExportError =>
    error instanceof CsvExportError
      ? error
      : new CsvExportError("source_failed", "A fonte de exportação falhou.");
  const emit = (chunk: Uint8Array): Uint8Array => {
    if (totalBytes + chunk.byteLength > maxBytes) {
      throw new CsvExportError("file_too_large", "A exportação excede o limite configurado.");
    }
    totalBytes += chunk.byteLength;
    archiveOffset += chunk.byteLength;
    return chunk;
  };
  const resolveBundleManifest = async (): Promise<ExportBundleManifest> => {
    if (bundleManifest) return bundleManifest;
    const values = await Promise.all(options.files.map((file) => file.manifest));
    const files = Object.freeze(values.map((value) => ({ ...value.files[0] })));
    bundleManifest = Object.freeze({
      manifestVersion: "1",
      schemaVersion: options.schemaVersion,
      domain: options.domain,
      generatedAt: options.generatedAt,
      timeZone: options.timeZone,
      currency: options.currency,
      filters: options.filters,
      files,
    });
    return bundleManifest;
  };
  const finish = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    resolveManifest(await resolveBundleManifest());
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (stage === "file") {
            if (currentReader === undefined) {
              if (currentIndex >= options.files.length) {
                const json = canonicalExportJson(await resolveBundleManifest());
                manifestBytes = new TextEncoder().encode(json);
                manifestStats = {
                  name: new TextEncoder().encode("manifest.json"),
                  crc32: finishCrc32(updateCrc32(0xffffffff, manifestBytes)),
                  size: manifestBytes.byteLength,
                  localOffset: archiveOffset,
                };
                stage = "manifest";
                continue;
              }
              const file = options.files[currentIndex];
              if (!file) throw new CsvExportError("invalid_schema", "Entrada ZIP inválida.");
              currentReader = file.stream.getReader();
              currentCrc = 0xffffffff;
              currentSize = 0;
              const name = new TextEncoder().encode(file.fileName);
              currentStats = { name, crc32: 0, size: 0, localOffset: archiveOffset };
              controller.enqueue(emit(localHeader(name)));
              return;
            }
            const next = await currentReader.read();
            if (!next.done) {
              currentCrc = updateCrc32(currentCrc, next.value);
              currentSize += next.value.byteLength;
              ensureZip32(currentSize);
              controller.enqueue(emit(next.value));
              return;
            }
            if (!currentStats) throw new CsvExportError("invalid_schema", "Entrada ZIP inválida.");
            const completed = {
              ...currentStats,
              crc32: finishCrc32(currentCrc),
              size: currentSize,
            };
            entries.push(completed);
            currentReader.releaseLock();
            currentReader = undefined;
            currentStats = undefined;
            currentIndex += 1;
            stage = "descriptor";
            controller.enqueue(emit(descriptor(completed)));
            return;
          }
          if (stage === "descriptor") {
            stage = "file";
            continue;
          }
          if (stage === "manifest") {
            if (!manifestBytes || !manifestStats) {
              throw new CsvExportError("invalid_schema", "Manifesto ZIP inválido.");
            }
            if (manifestReader === undefined) {
              manifestReader = new ReadableStream<Uint8Array>({
                start(streamController) {
                  streamController.enqueue(manifestBytes as Uint8Array);
                  streamController.close();
                },
              }).getReader();
              controller.enqueue(emit(localHeader(manifestStats.name)));
              return;
            }
            const next = await manifestReader.read();
            if (!next.done) {
              controller.enqueue(emit(next.value));
              return;
            }
            manifestReader.releaseLock();
            manifestReader = undefined;
            entries.push(manifestStats);
            controller.enqueue(emit(descriptor(manifestStats)));
            stage = "central";
            centralOffset = archiveOffset;
            centralEntries = entries.map(centralHeader);
            continue;
          }
          if (stage === "central") {
            const current = centralEntries?.shift();
            if (current) {
              controller.enqueue(emit(current));
              return;
            }
            const centralSize = archiveOffset - centralOffset;
            controller.enqueue(emit(endRecord(entries.length, centralSize, centralOffset)));
            await finish();
            stage = "done";
            return;
          }
          controller.close();
          return;
        }
      } catch (error) {
        const safe = fail(error);
        settled = true;
        rejectManifest(safe);
        await currentReader?.cancel().catch(() => undefined);
        controller.error(safe);
      }
    },
    async cancel() {
      const error = new CsvExportError(
        "stream_cancelled",
        "A exportação foi cancelada antes do fim.",
      );
      if (!settled) {
        settled = true;
        rejectManifest(error);
      }
      await currentReader?.cancel().catch(() => undefined);
      await manifestReader?.cancel().catch(() => undefined);
      for (const file of options.files) await file.stream.cancel().catch(() => undefined);
    },
  });
  for (const file of options.files) {
    void file.manifest.catch(() => undefined);
  }
  return {
    stream,
    fileName,
    contentType: "application/zip",
    manifest,
    manifestJson,
    manifestSha256,
  };
}
