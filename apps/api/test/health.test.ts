import { describe, expect, it } from "vitest";

import { app } from "../src/app.js";

describe("GET /health", () => {
  it("expõe o estado da API", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "casei-api", status: "ok" });
  });
});
