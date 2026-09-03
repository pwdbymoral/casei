import type { Pool } from "@casei/database";
import { IdempotencyConflictError, IdempotencyInProgressError } from "@casei/database";
import { ObjectStorageError } from "@casei/storage";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type {
  DataExchangeExportApplication,
  ImportUploadApplication,
} from "../src/data-exchange-routes.js";
import { ImportUploadError, parseMultipartImport } from "../src/data-exchange-routes.js";
import type { IdentityService } from "../src/identity-service.js";
import { importErrorToHttp, toImportJobResponse } from "../src/import-routes.js";
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

  it("includes rejected and skipped line errors in the job DTO", () => {
    expect(
      toImportJobResponse(
        {
          id: "job-1",
          workspaceId,
          state: "succeeded",
          cursor: 4,
          totalRows: 4,
          appliedRows: 2,
          skippedRows: 1,
          rejectedRows: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        [
          { lineNumber: 2, status: "applied" },
          { lineNumber: 3, status: "skipped", errorCode: "duplicate_suggestion" },
          { lineNumber: 4, status: "rejected", errorMessage: "Categoria inválida." },
        ],
      ),
    ).toMatchObject({
      errors: [
        { rowNumber: 3, message: "duplicate_suggestion" },
        { rowNumber: 4, message: "Categoria inválida." },
      ],
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
    form.set("sheetName", "Dados");

    const response = await appWith({ upload }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/previews`,
      { method: "POST", body: form, headers: { "Content-Length": "1000" } },
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      workspaceId,
      actorId: "requester-1",
      domain: "products",
      locale: "pt-BR",
      sheetName: "Dados",
      fileName: "produtos.csv",
    });
    expect((calls[0] as { bytes: Uint8Array }).bytes).toEqual(
      new TextEncoder().encode("nome\nArroz\n"),
    );
  });

  it("rejects an oversized multipart body before the parser buffers it", async () => {
    let parsed = false;
    const upload: ImportUploadApplication = {
      preview: async () => {
        parsed = true;
        throw new Error("the parser should not run");
      },
      confirm: async () => {
        throw new Error("the parser should not run");
      },
    };
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("domain", "products");
    form.set("locale", "pt-BR");
    const response = await appWith({ upload }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/previews`,
      {
        method: "POST",
        body: form,
        headers: { "Content-Length": "10000001" },
      },
    );
    expect(response.status).toBe(413);
    expect(parsed).toBe(false);
  });

  it("rejects a chunked multipart request before consuming the body", async () => {
    const upload: ImportUploadApplication = {
      preview: async () => {
        throw new Error("the application should not run");
      },
      confirm: async () => {
        throw new Error("the application should not run");
      },
    };
    const response = await appWith({ upload }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/previews`,
      {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=casei-boundary" },
        body: "this body must not be read",
      },
    );

    expect(response.status).toBe(413);
  });

  it("rejects a multipart request without Content-Length before parseBody", async () => {
    let parseBodyCalled = false;
    const context = {
      req: {
        header: () => undefined,
        parseBody: async () => {
          parseBodyCalled = true;
          throw new Error("parseBody must not be called");
        },
      },
    } as unknown as Parameters<typeof parseMultipartImport>[0];

    await expect(parseMultipartImport(context)).rejects.toMatchObject({ status: 413 });
    expect(parseBodyCalled).toBe(false);
  });

  it("rejects the aggregate file and field payload after parsing when no length is declared", async () => {
    let parsed = false;
    const upload: ImportUploadApplication = {
      preview: async () => {
        parsed = true;
        throw new Error("the aggregate limit should reject before application");
      },
      confirm: async () => {
        throw new Error("the aggregate limit should reject before application");
      },
    };
    const form = new FormData();
    form.set("file", new File([new Uint8Array(9_900_000)], "produtos.csv", { type: "text/csv" }));
    form.set("notes", "x".repeat(200_000));
    const response = await appWith({ upload }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/previews`,
      { method: "POST", body: form },
    );
    expect(response.status).toBe(413);
    expect(parsed).toBe(false);
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
      `http://localhost/v1/workspaces/${workspaceId}/data/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-key-123456", "Content-Length": "1000" },
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

  it("requires every duplicate suggestion to have an explicit review decision", async () => {
    const upload: ImportUploadApplication = {
      preview: async () => {
        throw new Error("not used");
      },
      confirm: async (input) => {
        expect(input.acceptedDuplicateLines).toEqual([3]);
        throw new ImportUploadError("Revise as duplicatas.", "invalid_preview");
      },
    };
    const application = { create: async () => ({}) } as unknown as ImportApplication;
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\nFeijão\n"], "produtos.csv", { type: "text/csv" }));
    form.set("previewId", "preview-1");
    form.set("mapping", JSON.stringify({ name: "nome" }));
    form.set("duplicatePolicy", "review");
    form.set("acceptedDuplicateLines", JSON.stringify([3]));
    form.set("applyMode", "valid_only");
    const response = await appWith({ upload, importApplication: application }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-review-123456", "Content-Length": "1000" },
      },
    );
    expect(response.status).toBe(422);
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
      `http://localhost/v1/workspaces/${workspaceId}/data/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-key-123456", "Content-Length": "1000" },
      },
    );

    expect(response.status).toBe(409);
  });

  it("maps import storage unavailability to HTTP 503", async () => {
    const upload: ImportUploadApplication = {
      preview: async () => {
        throw new Error("not used");
      },
      confirm: async () => {
        throw new ImportUploadError(
          "O armazenamento da importação está indisponível; tente novamente.",
          "storage_unavailable",
        );
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
      `http://localhost/v1/workspaces/${workspaceId}/data/imports`,
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "import-storage-123456", "Content-Length": "1000" },
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
  });

  it("maps storage errors in the import error boundary to HTTP 503", () => {
    expect(
      importErrorToHttp(
        new ImportUploadError(
          "O armazenamento da importação está indisponível; tente novamente.",
          "storage_unavailable",
        ),
      ),
    ).toMatchObject({
      status: 503,
      code: "internal_error",
    });
  });

  it.each(["invalid_object", "invalid_format", "scan_rejected"] as const)(
    "maps actionable import storage error %s to HTTP 422",
    (storageCode) => {
      expect(
        importErrorToHttp(new ObjectStorageError(storageCode, "invalid upload")),
      ).toMatchObject({
        status: 422,
        code: "validation_failed",
      });
    },
  );

  it.each([
    [new IdempotencyConflictError(), "idempotency_conflict"],
    [new IdempotencyInProgressError(), "idempotency_conflict"],
  ] as const)("maps concurrent import retry errors to %s", (error, code) => {
    expect(importErrorToHttp(error)).toMatchObject({ status: 409, code });
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
    const list = await app.request(`http://localhost/v1/workspaces/${workspaceId}/data/exports`);
    expect(list.status).toBe(200);
    const create = await app.request(`http://localhost/v1/workspaces/${workspaceId}/data/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "export-key-123456" },
      body: JSON.stringify({ domain: "transactions", format: "csv" }),
    });
    expect(create.status).toBe(202);
    const status = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/data/exports/export-1`,
    );
    expect(status.status).toBe(200);
    const download = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/data/exports/export-1/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("transactions.csv");
    await expect(download.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(calls).toEqual([`list:${workspaceId}`, "create:export-key-123456"]);
  });

  it.each([
    ["object_not_found", 404],
    ["object_expired", 410],
    ["storage_unavailable", 503],
    ["invalid_object", 422],
    ["invalid_format", 422],
    ["scan_rejected", 422],
  ] as const)("maps export storage state %s to HTTP %d", async (storageCode, status) => {
    const exports: DataExchangeExportApplication = {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw new Error("not used");
      },
      download: async () => {
        throw new ObjectStorageError(storageCode, "storage failure");
      },
    };
    const response = await appWith({ exports }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/exports/export-1/download`,
    );
    expect(response.status).toBe(status);
  });

  it("rejects impossible civil export dates before calling the application", async () => {
    const exports: DataExchangeExportApplication = {
      list: async () => [],
      create: async () => {
        throw new Error("the application must not receive invalid dates");
      },
      get: async () => {
        throw new Error("not used");
      },
      download: async () => {
        throw new Error("not used");
      },
    };

    const response = await appWith({ exports }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/exports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "export-date-123456" },
        body: JSON.stringify({ domain: "transactions", format: "csv", from: "2026-02-31" }),
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed", fieldErrors: { from: expect.any(Array) } },
    });
  });

  it("exposes import line errors through the scoped status route", async () => {
    const job = {
      id: "job-1",
      workspaceId,
      state: "succeeded",
      cursor: 2,
      totalRows: 2,
      appliedRows: 1,
      skippedRows: 1,
      rejectedRows: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as ImportJobRecord;
    const application = {
      getJob: async () => job,
      listResults: async () => ({
        items: [{ lineNumber: 3, status: "skipped", errorMessage: "Duplicata provável." }],
        nextAfterLine: null,
      }),
    } as unknown as ImportApplication;
    const response = await appWith({ importApplication: application }).request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/job-1`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ rowNumber: 3, message: "Duplicata provável." }],
    });
  });

  it("returns an explicit unavailable response instead of a route 404 without bootstrap", async () => {
    const app = appWith({});
    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/data/exports`,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
    const form = new FormData();
    form.set("file", new File(["nome\nArroz\n"], "produtos.csv", { type: "text/csv" }));
    form.set("domain", "products");
    form.set("locale", "pt-BR");
    const preview = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/previews`,
      { method: "POST", body: form },
    );
    expect(preview.status).toBe(503);
  });
});
