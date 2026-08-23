import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const workspaceId = "0190f3c8-2a10-7abc-8def-1234567890ab";

describe("AUTH-002..005 HTTP boundary", () => {
  it("requires an authenticated actor and keeps onboarding idempotency explicit", async () => {
    const unauthenticated = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => null,
      },
    });
    const denied = await unauthenticated.request("http://localhost/v1/me/workspaces");
    expect(denied.status).toBe(401);

    const preflight = await unauthenticated.request("http://localhost/v1/onboarding", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, idempotency-key",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");

    const app = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => ({
          userId: "user-1",
          email: "ada@example.com",
          displayName: "Ada",
          recentAuthentication: true,
        }),
      },
    });
    const missingKey = await app.request("http://localhost/v1/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Ada",
        workspaceName: "Casa",
        currency: "BRL",
        timeZone: "America/Fortaleza",
        initialBalanceMinor: "0",
        includeInitialBalance: false,
      }),
    });
    expect(missingKey.status).toBe(422);
  });

  it("rejects a workspace body without an authenticated scope instead of trusting a client id", async () => {
    const app = createApp(undefined, {
      identity: {
        pool: {} as never,
        actorResolver: async () => null,
      },
    });
    const response = await app.request(`http://localhost/v1/workspaces/${workspaceId}/recovery`);
    expect(response.status).toBe(401);
  });
});
