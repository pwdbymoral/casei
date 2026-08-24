import { afterEach, describe, expect, it, vi } from "vitest";

import { configuredApiOrigin, requireApiOrigin } from "./api-origin";

afterEach(() => vi.unstubAllEnvs());

describe("canonical API origin", () => {
  it("normalizes the build-provided public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "https://api.example.test///");
    expect(configuredApiOrigin()).toBe("https://api.example.test//");
    expect(requireApiOrigin()).toBe("https://api.example.test//");
  });

  it("fails closed when the build has no public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    expect(configuredApiOrigin()).toBeNull();
    expect(() => requireApiOrigin()).toThrow("A origem da API do Casei não foi configurada.");
  });
});
