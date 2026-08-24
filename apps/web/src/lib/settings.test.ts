import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticatedSettingsAdapter,
  preferenceChangeSummary,
  settingsErrorMessage,
} from "./settings";
import { WorkspaceManagementError } from "./workspaces";

describe("settings HTTP boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "http://localhost:3001");
    vi.stubEnv("NEXT_PUBLIC_CASEI_WEB_ORIGIN", "http://localhost:3000");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads and updates profile/preferences with ETags", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me/profile") && init?.method === "PATCH") {
        expect(init.headers).toMatchObject({ "If-Match": '"v2"' });
        return new Response(JSON.stringify({ version: 3 }), { status: 200 });
      }
      if (url.endsWith("/preferences") && init?.method === "PATCH") {
        expect(init.headers).toMatchObject({ "If-Match": '"v4"' });
        return new Response(JSON.stringify({ version: 5 }), { status: 200 });
      }
      return new Response(JSON.stringify({ version: 2 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authenticatedSettingsAdapter.updateProfile(
        { displayName: "Ana", locale: "pt-BR", hideValues: true },
        2,
      ),
    ).resolves.toMatchObject({ version: 3 });
    await expect(
      authenticatedSettingsAdapter.updateWorkspacePreferences(
        "workspace/1",
        {
          name: "Casa",
          currency: "BRL",
          timeZone: "America/Fortaleza",
          safetyMarginMinor: "1200",
        },
        4,
      ),
    ).resolves.toMatchObject({ version: 5 });
  });

  it("maps offline and optimistic-concurrency errors without leaking details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 412 })),
    );
    await expect(authenticatedSettingsAdapter.getProfile()).rejects.toMatchObject({ status: 412 });
    expect(settingsErrorMessage(new Error("offline"))).toBe("offline");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network"))),
    );
    await expect(authenticatedSettingsAdapter.getProfile()).rejects.toMatchObject({
      code: "offline",
    });
    expect(settingsErrorMessage(new WorkspaceManagementError(412))).toContain("mudou em outra aba");
  });

  it("delegates password, email and reverification to Better Auth native routes", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: init?.body as string | undefined });
        return new Response(JSON.stringify({ status: true }), { status: 200 });
      }),
    );

    await authenticatedSettingsAdapter.changePassword({
      currentPassword: "old-secret",
      newPassword: "new-secret",
    });
    await authenticatedSettingsAdapter.changeEmail("new@example.com");
    await authenticatedSettingsAdapter.sendVerificationEmail("owner@example.com");

    expect(requests.map(({ url }) => url)).toEqual([
      expect.stringContaining("/api/auth/change-password"),
      expect.stringContaining("/api/auth/change-email"),
      expect.stringContaining("/api/auth/send-verification-email"),
    ]);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      currentPassword: "old-secret",
      newPassword: "new-secret",
      revokeOtherSessions: false,
    });
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
      newEmail: "new@example.com",
      callbackURL: "http://localhost:3000/app/settings",
    });
    expect(JSON.parse(requests[2]?.body ?? "{}")).toMatchObject({
      email: "owner@example.com",
      callbackURL: "http://localhost:3000/app/settings",
    });
  });

  it("fails closed when the API or PWA origin is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "");
    await expect(authenticatedSettingsAdapter.getProfile()).rejects.toThrow(
      "NEXT_PUBLIC_CASEI_API_ORIGIN não está configurada",
    );

    vi.stubEnv("NEXT_PUBLIC_CASEI_API_ORIGIN", "http://localhost:3001");
    vi.stubEnv("NEXT_PUBLIC_CASEI_WEB_ORIGIN", "");
    expect(() => authenticatedSettingsAdapter.changeEmail("new@example.com")).toThrow(
      "NEXT_PUBLIC_CASEI_WEB_ORIGIN não está configurada",
    );
  });

  it("describes the consequences that the preferences preview must show", () => {
    const current = {
      workspaceId: "workspace-1",
      name: "Casa",
      currency: "BRL",
      timeZone: "America/Fortaleza",
      safetyMarginMinor: "0",
      version: 2,
    };
    expect(
      preferenceChangeSummary(current, {
        name: "Casa nova",
        currency: "USD",
        timeZone: "America/Sao_Paulo",
        safetyMarginMinor: "1200",
      }),
    ).toEqual([
      "Nome: Casa → Casa nova",
      "Moeda: BRL → USD (confirme que não há movimentos pendentes)",
      "Fuso horário: America/Fortaleza → America/Sao_Paulo (datas futuras serão exibidas neste fuso)",
      "Margem de segurança: 0 → 1200 centavos",
    ]);
  });
});
