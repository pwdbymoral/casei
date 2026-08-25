import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerFile = fileURLToPath(new URL("../src/import-worker.ts", import.meta.url));
const packageFile = fileURLToPath(new URL("../package.json", import.meta.url));

describe("DATA-004 worker entrypoint", () => {
  it("publishes a standalone worker with explicit adapter bootstrap", async () => {
    const source = await readFile(workerFile, "utf8");
    const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(source).toContain("CASEI_IMPORT_WORKER_BOOTSTRAP");
    expect(source).toContain("createImportWorkerBootstrap");
    expect(source).toContain("withUnitOfWork");
    expect(source).toContain("list_data_import_workspaces");
    expect(source).not.toContain('FROM "job"');
    expect(packageJson.scripts?.["worker:import"]).toBe("node dist/import-worker.js");
    expect(packageJson.scripts?.["worker:import:dev"]).toBe("tsx src/import-worker.ts");
    expect(packageJson.scripts?.build).toContain("src/import-worker.ts");
  });
});
