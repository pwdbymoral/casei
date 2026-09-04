"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClipboardPasteIcon,
  TablePropertiesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  StockAdapter,
  StockBulkApplyResult,
  StockBulkPreview,
  StockBulkPreviewRow,
} from "@/lib/stock";
import { StockAdapterError } from "@/lib/stock";

export type BulkDraft = {
  lineNumber: number;
  name: string;
  quantity: string;
  minimum: string;
  unit: string;
  unitLabel: string;
  shoppingAuto?: boolean;
  markedMissing?: boolean;
  category: string;
  location: string;
  note: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adapter: StockAdapter;
  workspaceId: string;
  onApplied: (result: StockBulkApplyResult) => void;
};

const statusLabel = {
  new: "Novo",
  update: "Atualização",
  duplicate: "Duplicata",
  invalid: "Erro",
} as const;

const statusClass = {
  new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  update: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  duplicate: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  invalid: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
} as const;

function value(row: StockBulkPreviewRow, field: string): string {
  const raw = row.values?.[field];
  return raw === undefined || raw === null ? "" : String(raw);
}

export function draftsFromPreview(preview: StockBulkPreview): BulkDraft[] {
  const has = (row: StockBulkPreviewRow, field: string) => Object.hasOwn(row.values ?? {}, field);
  return preview.rows.map((row) => ({
    lineNumber: row.lineNumber,
    name: row.name,
    quantity: value(row, "quantity"),
    minimum: value(row, "minimum"),
    unit: value(row, "unit"),
    unitLabel: value(row, "unitLabel"),
    ...(has(row, "shoppingAuto") ? { shoppingAuto: value(row, "shoppingAuto") !== "false" } : {}),
    ...(has(row, "markedMissing") ? { markedMissing: value(row, "markedMissing") === "true" } : {}),
    category: value(row, "category"),
    location: value(row, "location"),
    note: value(row, "note"),
  }));
}

function csvCell(raw: string): string {
  return raw.includes("\t") || raw.includes('"') ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export function contentFromDrafts(rows: BulkDraft[]): string {
  return [
    "Nome\tQuantidade\tMínimo\tUnidade\tRótulo\tComprar automaticamente\tFaltando\tCategoria\tLocal\tNota",
    ...rows.map((row) =>
      [
        row.name,
        row.quantity,
        row.minimum,
        row.unit,
        row.unitLabel,
        row.shoppingAuto === undefined ? "" : row.shoppingAuto ? "sim" : "não",
        row.markedMissing === undefined ? "" : row.markedMissing ? "sim" : "não",
        row.category,
        row.location,
        row.note,
      ]
        .map(csvCell)
        .join("\t"),
    ),
  ].join("\n");
}

export function StockBulkDialog({ open, onOpenChange, adapter, workspaceId, onApplied }: Props) {
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<StockBulkPreview | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [applyKey, setApplyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<BulkDraft[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState<"valid_only" | "all_or_nothing">("valid_only");
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "actionable" | "errors">("all");

  useEffect(() => {
    if (!open) {
      setContent("");
      setPreview(null);
      setPreviewContent(null);
      setApplyKey(null);
      setDrafts([]);
      setAdvanced(false);
      setMode("valid_only");
      setError(null);
      setFilter("all");
    }
  }, [open]);

  const visibleRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows.filter((row) =>
      filter === "all"
        ? true
        : filter === "errors"
          ? row.status === "invalid" || row.status === "duplicate"
          : row.status === "new" || row.status === "update",
    );
  }, [filter, preview]);

  const visibleDrafts = useMemo(() => {
    if (!preview) return [];
    return drafts
      .map((draft, index) => ({ draft, index, status: preview.rows[index]?.status }))
      .filter(({ status }) =>
        filter === "all"
          ? true
          : filter === "errors"
            ? status === "invalid" || status === "duplicate"
            : status === "new" || status === "update",
      );
  }, [drafts, filter, preview]);

  async function requestPreview() {
    if (!content.trim()) {
      setError("Cole ou digite pelo menos um produto.");
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const result = await adapter.previewBulkProducts(workspaceId, content);
      setPreview(result);
      setPreviewContent(content);
      setApplyKey(`stock-bulk-${globalThis.crypto.randomUUID()}`);
      setDrafts(draftsFromPreview(result));
      if (result.canApplyAllOrNothing) setMode("all_or_nothing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar a prévia.");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy("apply");
    setError(null);
    try {
      const result = await adapter.applyBulkProducts(
        workspaceId,
        { content, mode, previewHash: preview.contentHash },
        applyKey ?? `stock-bulk-${globalThis.crypto.randomUUID()}`,
      );
      if (!result.committed) {
        setPreview(result.preview);
        setPreviewContent(null);
        setApplyKey(null);
        setDrafts(draftsFromPreview(result.preview));
        setError("Nada foi aplicado. Revise as linhas destacadas e gere uma nova prévia.");
        return;
      }
      onApplied(result);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof StockAdapterError && cause.status === 409
          ? "A lista mudou enquanto você revisava. Gere uma nova prévia antes de confirmar."
          : cause instanceof Error
            ? cause.message
            : "Não foi possível aplicar o lote.",
      );
    } finally {
      setBusy(null);
    }
  }

  function updateDraft(index: number, field: keyof BulkDraft, next: string | boolean) {
    setDrafts((current) => {
      const updated = current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: next } : row,
      );
      setContent(contentFromDrafts(updated));
      return updated;
    });
    setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adicionar produtos em lote</DialogTitle>
          <DialogDescription>
            Cole uma lista com um produto por linha ou uma tabela copiada do Excel/Planilhas. Nada é
            salvo antes de você revisar a prévia.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="stock-bulk-content">Produtos</Label>
            <textarea
              id="stock-bulk-content"
              className="min-h-36 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setPreview(null);
                setPreviewContent(null);
                setApplyKey(null);
                setError(null);
              }}
              placeholder={"Arroz\nFeijão\nLeite"}
              aria-describedby="stock-bulk-help"
            />
            <p id="stock-bulk-help" className="text-xs text-muted-foreground">
              Para detalhes, use cabeçalhos: Nome, Quantidade, Mínimo, Unidade, Categoria, Local e
              Nota. Separe por TAB ou ponto e vírgula.
            </p>
          </div>

          {error ? (
            <p
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void requestPreview()} disabled={busy !== null}>
              <ClipboardPasteIcon aria-hidden="true" />
              {busy === "preview" ? "Analisando…" : "Gerar prévia"}
            </Button>
            {preview ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setAdvanced((current) => !current)}
                aria-pressed={advanced}
              >
                <TablePropertiesIcon aria-hidden="true" />
                {advanced ? "Usar texto" : "Modo avançado"}
              </Button>
            ) : null}
          </div>

          {preview ? (
            <Card>
              <CardContent className="grid gap-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-medium">Prévia da importação</h3>
                    <p className="text-sm text-muted-foreground">
                      {preview.rows.length}{" "}
                      {preview.rows.length === 1 ? "linha analisada" : "linhas analisadas"}. Revise
                      erros e duplicatas antes de confirmar.
                    </p>
                  </div>
                  <div
                    className="flex flex-wrap gap-2 text-xs"
                    role="status"
                    aria-label="Resumo da prévia"
                  >
                    {Object.entries(preview.counts).map(([status, count]) => (
                      <span
                        key={status}
                        className={`rounded-full px-2 py-1 ${statusClass[status as keyof typeof statusClass]}`}
                      >
                        {statusLabel[status as keyof typeof statusLabel]}: {count}
                      </span>
                    ))}
                  </div>
                </div>
                {preview.fatalErrors.length > 0 ? (
                  <div
                    className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                    role="alert"
                  >
                    <p className="font-medium">Não foi possível interpretar a tabela:</p>
                    <ul className="mt-1 list-inside list-disc">
                      {preview.fatalErrors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <fieldset className="flex flex-wrap items-center gap-2">
                  <legend className="text-sm font-medium">Mostrar:</legend>
                  {(["all", "actionable", "errors"] as const).map((option) => (
                    <Button
                      key={option}
                      type="button"
                      size="sm"
                      variant={filter === option ? "secondary" : "outline"}
                      aria-pressed={filter === option}
                      onClick={() => setFilter(option)}
                    >
                      {option === "all"
                        ? "Todas"
                        : option === "actionable"
                          ? "Aplicáveis"
                          : "Erros"}
                    </Button>
                  ))}
                </fieldset>

                {advanced ? (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <caption className="sr-only">
                        Tabela avançada para editar produtos antes da prévia
                      </caption>
                      <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="w-14 px-3 py-2">Linha</th>
                          <th className="px-3 py-2">Nome</th>
                          <th className="w-28 px-3 py-2">Quantidade</th>
                          <th className="w-24 px-3 py-2">Mínimo</th>
                          <th className="w-28 px-3 py-2">Unidade</th>
                          <th className="w-28 px-3 py-2">Rótulo</th>
                          <th className="px-3 py-2">Categoria</th>
                          <th className="px-3 py-2">Local</th>
                          <th className="px-3 py-2">Nota</th>
                          <th className="w-24 px-3 py-2">Compra auto.</th>
                          <th className="w-24 px-3 py-2">Faltando</th>
                          <th className="w-44 px-3 py-2">Resultado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDrafts.map(({ draft: row, index }) => (
                          <tr key={row.lineNumber} className="border-t align-top">
                            <td className="px-3 py-2 text-muted-foreground">{row.lineNumber}</td>
                            {(
                              [
                                "name",
                                "quantity",
                                "minimum",
                                "unit",
                                "unitLabel",
                                "category",
                                "location",
                                "note",
                              ] as const
                            ).map((field) => (
                              <td key={field} className="px-2 py-2">
                                <Input
                                  value={row[field]}
                                  onChange={(event) =>
                                    updateDraft(index, field, event.target.value)
                                  }
                                  aria-label={`${field} da linha ${row.lineNumber}`}
                                  className="h-9"
                                />
                              </td>
                            ))}
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={row.shoppingAuto}
                                onChange={(event) =>
                                  updateDraft(index, "shoppingAuto", event.target.checked)
                                }
                                aria-label={`Compra automática da linha ${row.lineNumber}`}
                              />
                            </td>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={row.markedMissing}
                                onChange={(event) =>
                                  updateDraft(index, "markedMissing", event.target.checked)
                                }
                                aria-label={`Faltando da linha ${row.lineNumber}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-xs">
                              <span
                                className={`rounded-full px-2 py-1 ${statusClass[preview.rows[index]?.status ?? "invalid"]}`}
                              >
                                {statusLabel[preview.rows[index]?.status ?? "invalid"]}
                              </span>
                              {preview.rows[index]?.errors.length ? (
                                <span className="mt-2 block text-destructive" role="alert">
                                  {preview.rows[index]?.errors.join(" ")}
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[620px] text-left text-sm">
                      <caption className="sr-only">Resultado linha a linha da prévia</caption>
                      <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="w-14 px-3 py-2">Linha</th>
                          <th className="px-3 py-2">Produto</th>
                          <th className="w-32 px-3 py-2">Resultado</th>
                          <th className="px-3 py-2">Detalhes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row) => (
                          <tr key={row.lineNumber} className="border-t align-top">
                            <td className="px-3 py-2 text-muted-foreground">{row.lineNumber}</td>
                            <td className="px-3 py-2 font-medium break-words">
                              {row.name || "(sem nome)"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${statusClass[row.status]}`}
                              >
                                {row.status === "invalid" ? (
                                  <AlertCircleIcon className="size-3" aria-hidden="true" />
                                ) : (
                                  <CheckCircle2Icon className="size-3" aria-hidden="true" />
                                )}
                                {statusLabel[row.status]}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {row.errors.length
                                ? row.errors.join(" ")
                                : row.changes
                                    .map(
                                      (change) =>
                                        `${change.field}: ${String(change.after ?? "vazio")}`,
                                    )
                                    .join(" · ") || "Sem alteração"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Como confirmar</legend>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="stock-bulk-mode"
                      value="valid_only"
                      checked={mode === "valid_only"}
                      onChange={() => setMode("valid_only")}
                    />
                    <span>
                      <strong>Aplicar somente válidas</strong>
                      <span className="block text-xs text-muted-foreground">
                        Ignora duplicatas e mantém erros sem alterar o restante.
                      </span>
                    </span>
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="stock-bulk-mode"
                      value="all_or_nothing"
                      checked={mode === "all_or_nothing"}
                      onChange={() => setMode("all_or_nothing")}
                    />
                    <span>
                      <strong>Aplicar tudo ou nada</strong>
                      <span className="block text-xs text-muted-foreground">
                        Só confirma quando todas as linhas forem válidas.
                      </span>
                    </span>
                  </label>
                </fieldset>
                {previewContent !== content ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
                    Você editou a tabela. Gere uma nova prévia para validar as mudanças antes de
                    confirmar.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy !== null}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void apply()}
            disabled={
              !preview ||
              previewContent !== content ||
              busy !== null ||
              (mode === "valid_only" ? !preview?.canApplyValidOnly : !preview?.canApplyAllOrNothing)
            }
          >
            {busy === "apply" ? "Aplicando…" : "Confirmar cadastro"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
