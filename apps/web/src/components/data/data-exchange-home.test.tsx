import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DataExchangeAdapter } from "@/lib/data-exchange";

let currentSearchParams = new URLSearchParams();
let currentRole: "owner" | "member" | "viewer" = "member";

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

vi.mock("@/components/shell/app-shell", () => ({
  useAuthenticatedWorkspace: () => ({
    workspaceId: "workspace-1",
    role: currentRole,
    fixtureMode: false,
    timeZone: "America/Fortaleza",
    currency: "BRL",
  }),
}));

import { DataExchangeHome } from "./data-exchange-home";

const adapter = {
  listExportJobs: vi.fn().mockResolvedValue([]),
} as unknown as DataExchangeAdapter;

function renderSurface(search = "") {
  currentSearchParams = new URLSearchParams(search);
  return renderToStaticMarkup(<DataExchangeHome adapter={adapter} />);
}

describe("DataExchangeHome", () => {
  it("expõe as etapas da importação e limites no primeiro estado", () => {
    currentRole = "member";
    const html = renderSurface();

    expect(html).toContain("Importar e exportar");
    expect(html).toContain('aria-label="Etapas da importação"');
    expect(html).toContain('id="import-file"');
    expect(html).toContain("Limite: 10 MB.");
    expect(html).toContain("Escolha um arquivo para começar");
  });

  it("mostra permissão de leitura e bloqueia o fluxo de importação para viewer", () => {
    currentRole = "viewer";
    const html = renderSurface();

    expect(html).toContain("Importação restrita");
    expect(html).toContain("não importar alterações");
    expect(html).toMatch(/id="import-file"[^>]*disabled/);
    expect(html).toContain("Exportar dados");
  });

  it("bloqueia a geração quando o período é invertido e explica o erro", () => {
    currentRole = "member";
    const html = renderSurface("from=2026-09-05&to=2026-09-04");

    expect(html).toContain("A data final deve ser igual ou posterior à data inicial.");
    expect(html).toMatch(/Gerar exportação/);
    const generateButtonIndex = html.indexOf("Gerar exportação");
    expect(html.slice(Math.max(0, generateButtonIndex - 2_000), generateButtonIndex)).toContain(
      "disabled",
    );
  });
});
