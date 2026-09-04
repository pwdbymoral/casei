import type { Pool } from "@casei/database";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { IdentityService } from "../src/identity-service.js";
import type { ImportApplication } from "../src/import-service.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";

describe("DATA-004 HTTP boundary", () => {
  it("composes actor authentication before workspace scope on line results", async () => {
    const identityService = {
      resolveScope: async (_actor: unknown, id: string) => ({
        actor: { userId: "requester-1" },
        workspaceId: id,
        role: "member" as const,
        correlationId: "correlation-from-request",
      }),
    } as unknown as IdentityService;
    const application = {
      listResults: async (
        jobId: string,
        scope: string,
        afterLine: number | undefined,
        limit: number,
      ) => {
        expect(jobId).toBe("job-1");
        expect(scope).toBe(workspaceId);
        expect(afterLine).toBe(2);
        expect(limit).toBe(1);
        return {
          items: [{ lineNumber: 3, status: "skipped", errorCode: "duplicate" }],
          nextAfterLine: null,
        };
      },
    } as unknown as ImportApplication;
    const app = createApp(undefined, {
      identity: {
        pool: {} as Pool,
        service: identityService,
        actorResolver: async () => ({ userId: "requester-1" }),
      },
      import: { application },
    });

    const response = await app.request(
      `http://localhost/v1/workspaces/${workspaceId}/data/imports/job-1/lines?afterLine=2&limit=1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ lineNumber: 3, status: "skipped", errorCode: "duplicate" }],
      page: { nextAfterLine: null },
    });
  });
});
