import { describe, expect, it } from "vitest";
import { contentFromDrafts, draftsFromPreview } from "./stock-bulk-dialog";

describe("edição avançada do cadastro em lote", () => {
  it("preserva campos opcionais ausentes ao editar outra coluna", () => {
    const [draft] = draftsFromPreview({
      contentHash: "a".repeat(64),
      headers: ["Nome", "Categoria"],
      fatalErrors: [],
      rows: [
        {
          lineNumber: 2,
          status: "update",
          name: "Arroz",
          values: { name: "Arroz", category: "Despensa" },
          changes: [{ field: "category", before: null, after: "Despensa" }],
          errors: [],
        },
      ],
      counts: { new: 0, update: 1, duplicate: 0, invalid: 0 },
      canApplyValidOnly: true,
      canApplyAllOrNothing: true,
    });
    if (!draft) throw new Error("draft ausente");

    const content = contentFromDrafts([{ ...draft, category: "Despensa nova" }]);
    expect(content).toContain("Comprar automaticamente\tFaltando");
    expect(content.split("\n")[1]?.split("\t").slice(5, 7)).toEqual(["", ""]);
  });
});
