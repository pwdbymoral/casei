import { describe, expect, it } from "vitest";

import {
  applyCsvMappingProfile,
  type CsvFieldDefinition,
  createCsvMappingProfile,
  mapCsvColumns,
} from "../src/index.js";

const fields: readonly CsvFieldDefinition<string>[] = [
  { key: "description", aliases: ["descrição"], required: true },
  { key: "amount", aliases: ["valor"], required: true },
];

describe("perfis de mapeamento", () => {
  it("salva somente a preferência normalizada e reaplica em cabeçalho equivalente", () => {
    const headers = ["Descrição", "Valor", "Banco"];
    const mapping = mapCsvColumns(headers, fields).mapping;
    const profile = createCsvMappingProfile({
      name: "  Extrato mensal  ",
      domain: "transactions",
      headers,
      mapping,
      locale: "pt-BR",
    });

    expect(profile).toEqual({
      version: "1",
      name: "Extrato mensal",
      domain: "transactions",
      locale: "pt-BR",
      mapping: { description: "descricao", amount: "valor" },
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.mapping)).toBe(true);

    const reapplied = applyCsvMappingProfile(profile, [" DESCRIÇÃO ", "VALOR"], fields);
    expect(reapplied.mapping).toEqual({ description: " DESCRIÇÃO ", amount: "VALOR" });
    expect(reapplied.mappingErrors).toEqual([]);
  });

  it("não salva coluna ausente ou duplicada e mantém ambiguidade explícita", () => {
    expect(() =>
      createCsvMappingProfile({
        name: "Perfil",
        domain: "transactions",
        headers: ["Valor"],
        mapping: { amount: "Descrição" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_mapping" }));

    const profile = createCsvMappingProfile({
      name: "Perfil",
      domain: "transactions",
      headers: ["Valor"],
      mapping: { amount: "Valor" },
    });
    const reapplied = applyCsvMappingProfile(profile, ["Valor", "valor"], fields);
    expect(reapplied.mappingErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ambiguous_mapping", field: "amount" }),
        expect.objectContaining({ code: "missing_required", field: "description" }),
      ]),
    );
  });

  it("valida nome e domínio antes de permitir persistência pelo chamador", () => {
    expect(() =>
      createCsvMappingProfile({
        name: "\n",
        domain: "transactions",
        headers: ["Valor"],
        mapping: { amount: "Valor" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
    expect(() =>
      createCsvMappingProfile({
        name: "Perfil",
        domain: "Transactions",
        headers: ["Valor"],
        mapping: { amount: "Valor" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_domain" }));
  });
});
