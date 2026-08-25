import type { Pool } from "@casei/database";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type {
  DataExchangeExportApplication,
  ImportUploadApplication,
} from "../src/data-exchange-routes.js";
import { ImportUploadError } from "../src/data-exchange-routes.js";
import type { IdentityService } from "../src/identity-service.js";
import { toImportJobResponse } from "../src/import-routes.js";
import type { ImportApplication, ImportJobRecord } from "../src/import-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";

function appWith(options: {
  upload?: ImportUploadApplication;
  exports?: DataExchangeExportApplication;
  importApplication?: ImportApplication;
  role?: "owner" | "member" | "viewer";
}) {
  const identityService = {
    resolveScope: async (_actor: unknown, id: string) => ({
      actor: { userId: "requester-1" },
      workspaceId: id,
      role: options.role ?? "member",
      correlationId: "correlation-data",
    }),
  } as unknown as IdentityService;
  return createApp(undefined, {
    identity: {
      pool: {} as Pool,
      service: identityService,
      actorResolver: async () => ({ userId: "requester-1" }),
    },
    ...(options.importApplication || options.upload
      ? {
          import: {
            application: options.importApplication as ImportApplication,
            upload: options.upload,
          },
        }
      : {}),
    ...(options.exports ? { dataExchange: { exports: options.exports } } : {}),
  });
}

describe("DATA-006 HTTP boundary", () => {
  it("maps the internal DATA-004 state to the stable UI job DTO", () => {
    expect(
      toImportJobResponse({
        id: "job-1",
        workspaceId,
        state: "succeeded",
        cursor: 8,
        totalRows: 8,
        appliedRows: 7,
        skippedRows: 1,
        rejectedRows: 0,
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-26T12:00:00.000Z",
      }),
    ).toEqual({
      id: "job-1",
      workspaceId,
      status: "completed",
      progress: 100,
      totalRows: 8,
      appliedRows: 7,
      ignoredRows: 1,
      rejectedRows: 0,
      errors: [],
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-26T12:00:00.000Z",
    });
  });

  it("passes multipart preview through actor and workspace scope", async () => {
    const calls: unknown[] = [];
    const upload: ImportUploadApplication = {
      preview: async (input) => {
        calls.push(input);
        return {
          id: "preview-1",
          workspaceId,
          fileName: input.fileName,
          fileSize: input.bytes.byteLength,
          format: "csv",
          domain: input.domain,
          headers: ["nome"],
          rows: [],
          fields: [],
          mapping: {},
          unknownHeaders: [],
          locale: input.locale,
          serverBacked: true,
          canConfirm: true,
          counts: { valid: 0, warnings: 0, duplicates: 0, errors: 0 },
          storageKey: "dev/0190f3c8-2a10-7abc-8def-1234567890ab/preview-1.csv",
          sourceHash: "a".repeat(64),
          previewHash: "b".repeat(64),
          mappingVersion: "mapping-1",
          previewManifest: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      confirm: async () => {
        throw new Error("not used");
      },
    };
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("domain", "products");
    form.set("locale", "pt-BR");

    const response = await appWith({ upload }).request(
      `http://localhost/v1/workspaces/${workspaceId}/imports/previews`,
      { method: "POST", body: form },
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      workspaceId,
      actorId: "requester-1",
      domain: "products",
      locale: "pt-BR",
      fileName: "produtos.csv",
    });
    expect((calls[0] as { bytes: Uint8Array }).bytes).toEqual(
      new TextEncoder().encode("nome\nArroz\n"),
    );
  });

  it("confirms multipart only after the preview application validates the source", async () => {
    const confirms: unknown[] = [];
    const job = { id: "job-1", workspaceId, state: "queued" } as ImportJobRecord;
    const upload: ImportUploadApplication = {
      preview: async () => {
        throw new Error("not used");
      },
      confirm: async (input) => {
        confirms.push(input);
        return {
          domain: "products",
          storageKey: "dev/0190f3c8-2a10-7abc-8def-1234567890ab/preview-1.csv",
          sourceHash: "a".repeat(64),
          mappingVersion: "mapping-1",
          previewHash: "b".repeat(64),
          previewManifest: [{ lineNumber: 2, status: "valid", rowDigest: "c".repeat(64) }],
          mode: input.mode,
          duplicatePolicy: input.duplicatePolicy,
          acceptedDuplicateLines: [],
          totalRows: 1,
          validRows: 1,
          duplicateRows: 0,
          invalidRows: 0,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const application = {
      create: async (input: Parameters<ImportApplication["create"]>[0]) => {
        expect(input.idempotencyKey).toBe("import-key-123456");
        return job;
      },
    } as unknown as ImportApplication;
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("previewId", "preview-1");
    form.set("mapping", JSON.stringify({ name: "nome" }));
    form.set("duplicatePolicy", "ignore");
    form.set("applyMode", "all_or_nothing");

    const response = await appWith({ upload, importApplication: application }).request(
      `http://localhost/v1/workspaces/${workspaceId}/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-key-123456" },
      },
    );

    expect(response.status).toBe(202);
    expect(confirms[0]).toMatchObject({
      workspaceId,
      actorId: "requester-1",
      previewId: "preview-1",
      mapping: { name: "nome" },
      mode: "all_or_nothing",
      duplicatePolicy: "skip",
    });
  });

  it("maps stale preview errors to a conflict instead of leaking an internal error", async () => {
    const upload: ImportUploadApplication = {
      preview: async () => {
        throw new Error("not used");
      },
      confirm: async () => {
        throw new ImportUploadError("O arquivo confirmado diverge da prévia.", "source_mismatch");
      },
    };
    const application = { create: async () => ({}) } as unknown as ImportApplication;
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("previewId", "preview-1");
    form.set("mapping", JSON.stringify({ name: "nome" }));
    form.set("duplicatePolicy", "ignore");
    form.set("applyMode", "valid_only");

    const response = await appWith({ upload, importApplication: application }).request(
      `http://localhost/v1/workspaces/${workspaceId}/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-key-123456" },
      },
    );

    expect(response.status).toBe(409);
  });

  it("exposes export list/create/status/download behind the same scope", async () => {
    const calls: string[] = [];
    const exports: DataExchangeExportApplication = {
      list: async (input) => {
        calls.push(`list:${input.workspaceId}`);
        return [];
      },
      create: async (input) => {
        calls.push(`create:${input.idempotencyKey}`);
        return {
          id: "export-1",
          workspaceId,
          domain: "transactions",
          format: "csv",
          status: "queued",
          progress: 0,
          fileName: "transactions.csv",
          createdAt: "2026-08-25T12:00:00.000Z",
          expiresAt: "2026-08-26T12:00:00.000Z",
        };
      },
      get: async () => ({
        id: "export-1",
        workspaceId,
        domain: "transactions",
        format: "csv",
        status: "completed",
        progress: 100,
        fileName: "transactions.csv",
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-26T12:00:00.000Z",
      }),
      download: async () => ({
        body: new Uint8Array([1, 2, 3]),
        contentType: "text/csv; charset=utf-8",
        fileName: "transactions.csv",
      }),
    };
    const app = appWith({ exports, role: "viewer" });
    const list = await app.request(`http://localhost/v1/workspaces/${workspaceId}/exports`);
    expect(list.status).toBe(200);
    const create = await app.request(`http://localhost/v1/workspaces/${workspaceId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "export-key-123456" },
      body: JSON.stringify({ domain: "transactions", format: "csv" }),
    });
    expect(create.status).toBe(202);
    const status = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/exports/export-1`,
    );
    expect(status.status).toBe(200);
    const download = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/exports/export-1/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("transactions.csv");
    await expect(download.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(calls).toEqual([`list:${workspaceId}`, "create:export-key-123456"]);
  });

  it("returns an explicit unavailable response instead of a route 404 without bootstrap", async () => {
    const app = appWith({});
    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/exports`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("domain", "products");
    form.set("locale", "pt-BR");
    const preview = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/imports/previews`,
      { method: "POST", body: form },
    );
    expect(preview.status).toBe(503);
  });
});
