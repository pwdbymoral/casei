"use client";

import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  HistoryIcon,
  MinusIcon,
  PackagePlusIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AsyncState, StatusBadge } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  canWriteStock,
  type StockAdapter,
  type StockMovement,
  type StockMovementKind,
  type StockProduct,
  type StockUnit,
  stockAdapterForEnvironment,
  stockStateLabel,
  stockUnitLabel,
} from "@/lib/stock";

const unitOptions: StockUnit[] = ["unit", "package", "box", "kg", "g", "L", "ml", "other"];

export function StockHome() {
  const { workspaceId, role, fixtureMode } = useAuthenticatedWorkspace();
  const adapter = useMemo<StockAdapter>(
    () => stockAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const writable = canWriteStock(role);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState<"loading" | "success" | "empty" | "error" | "offline">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<StockUnit>("unit");
  const [newQuantity, setNewQuantity] = useState("");
  const [newMinimum, setNewMinimum] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<StockProduct | null>(null);
  const [history, setHistory] = useState<StockMovement[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const generation = useRef(0);
  const mutationToken = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setStatus("loading");
    setError(null);
    try {
      const next = await adapter.listProducts(workspaceId, {
        query,
        includeArchived: showArchived,
      });
      if (current !== generation.current) return;
      setProducts(next);
      setStatus(next.length ? "success" : "empty");
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o estoque.");
      setStatus("error");
    }
  }, [adapter, query, showArchived, workspaceId]);

  useEffect(() => {
    setProducts([]);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  async function mutate(
    key: string,
    operation: () => Promise<StockProduct | { product: StockProduct }>,
  ) {
    const requestGeneration = generation.current;
    const currentMutation = ++mutationToken.current;
    setBusy(key);
    setError(null);
    try {
      await operation();
      if (requestGeneration === generation.current && currentMutation === mutationToken.current)
        await load();
    } catch (cause) {
      if (requestGeneration === generation.current && currentMutation === mutationToken.current)
        setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o estoque.");
    } finally {
      if (currentMutation === mutationToken.current) setBusy(null);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim()) return;
    await mutate("new", async () => {
      const product = await adapter.createProduct(workspaceId, {
        name: newName,
        unit: newUnit,
        quantity: newQuantity || null,
        minimum: newMinimum || null,
      });
      setNewName("");
      setNewQuantity("");
      setNewMinimum("");
      setDetailsOpen(false);
      setNewProductOpen(false);
      return product;
    });
  }

  async function quick(product: StockProduct, kind: "entry" | "consume" | "correction") {
    const quantity = kind === "correction" ? amount : amount || "1";
    await mutate(product.id, () =>
      adapter.createMovement(workspaceId, product, { kind, quantity }),
    );
  }

  async function openHistory(product: StockProduct) {
    setHistoryProduct(product);
    setHistoryBusy(true);
    try {
      setHistory(await adapter.listMovements(workspaceId, product.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o histórico.");
    } finally {
      setHistoryBusy(false);
    }
  }

  const visibleProducts = products;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Vida doméstica</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Estoque de casa</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Veja rapidamente o que está em casa e ajuste quantidades em poucos toques.
          </p>
        </div>
        {writable ? (
          <Button type="button" onClick={() => setNewProductOpen((value) => !value)}>
            <PackagePlusIcon aria-hidden="true" />
            Adicionar produto
          </Button>
        ) : null}
      </header>

      {newProductOpen && writable ? (
        <form onSubmit={createProduct} aria-label="Adicionar produto">
          <Card>
            <CardHeader>
              <CardTitle>Novo produto</CardTitle>
              <CardDescription>Comece só pelo nome; os detalhes podem esperar.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="stock-new-name">Nome</Label>
                <Input
                  id="stock-new-name"
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Ex.: café"
                  required
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="stock-new-unit">Unidade</Label>
                  <select
                    id="stock-new-unit"
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    value={newUnit}
                    onChange={(event) => setNewUnit(event.target.value as StockUnit)}
                  >
                    {unitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {stockUnitLabel[unit]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="stock-new-quantity">Quantidade inicial</Label>
                  <Input
                    id="stock-new-quantity"
                    inputMode="decimal"
                    value={newQuantity}
                    onChange={(event) => setNewQuantity(event.target.value)}
                    placeholder="Opcional"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="stock-new-minimum">Mínimo desejado</Label>
                  <Input
                    id="stock-new-minimum"
                    inputMode="decimal"
                    value={newMinimum}
                    onChange={(event) => setNewMinimum(event.target.value)}
                    placeholder="Opcional"
                  />
                </div>
              </div>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDetailsOpen((value) => !value)}
                  aria-expanded={detailsOpen}
                >
                  <ChevronDownIcon aria-hidden="true" />
                  Mais detalhes
                </Button>
                {detailsOpen ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Categoria, local e observações podem ser editados depois no modo avançado.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy === "new"}>
                  {busy === "new" ? "Salvando…" : "Salvar produto"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setNewProductOpen(false)}>
                  Cancelar
                </Button>
              </div>
            </CardContent>
          </Card>
        </form>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Buscar estoque">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-11 pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar produto"
              aria-label="Buscar produto"
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Mostrar arquivados
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {visibleProducts.length} {visibleProducts.length === 1 ? "produto" : "produtos"}
          </p>
          <div className="flex items-center gap-2">
            <Label htmlFor="stock-amount">Quantidade rápida</Label>
            <Input
              id="stock-amount"
              className="h-11 w-24"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
        </div>
      </section>

      {error ? (
        <AsyncState
          status="error"
          title="Não foi possível atualizar o estoque"
          description={error}
          action={{ label: "Tentar novamente", onClick: () => void load() }}
        />
      ) : null}
      {status === "loading" ? <AsyncState status="loading" /> : null}
      {status === "empty" ? (
        <AsyncState
          status="empty"
          title="Nenhum produto encontrado"
          description={
            query
              ? "Tente outra busca ou cadastre um produto."
              : "Cadastre o primeiro produto com apenas um nome."
          }
          action={
            writable
              ? { label: "Adicionar produto", onClick: () => setNewProductOpen(true) }
              : undefined
          }
        />
      ) : null}
      {status === "success" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {visibleProducts.map((product) => (
            <StockProductCard
              key={product.id}
              product={product}
              writable={writable}
              busy={busy === product.id}
              amount={amount}
              onMove={(kind) => void quick(product, kind)}
              onMissing={() =>
                void mutate(product.id, () =>
                  adapter.markMissing(workspaceId, product, !product.markedMissing),
                )
              }
              onArchive={() =>
                void mutate(product.id, () =>
                  product.archived
                    ? adapter.restore(workspaceId, product)
                    : adapter.archive(workspaceId, product),
                )
              }
              onHistory={() => void openHistory(product)}
            />
          ))}
        </div>
      ) : null}
      {historyProduct ? (
        <Card aria-label={`Histórico de ${historyProduct.name}`}>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Histórico · {historyProduct.name}</CardTitle>
                <CardDescription>
                  Movimentações são append-only e mostram antes, depois e autoria.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setHistoryProduct(null)}
                aria-label="Fechar histórico"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {historyBusy ? (
              <p role="status">Carregando histórico…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nenhuma movimentação registrada ainda.
              </p>
            ) : (
              <ol className="flex flex-col divide-y">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                  >
                    <span>
                      <strong>{movementLabel[item.kind]}</strong> · {item.quantity}{" "}
                      {stockUnitLabel[historyProduct.unit]}
                    </span>
                    <span className="text-muted-foreground">
                      {item.before ?? "—"} → {item.after ?? "—"} ·{" "}
                      {new Date(item.occurredAt).toLocaleString("pt-BR")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

const movementLabel: Record<StockMovementKind, string> = {
  entry: "Entrada",
  consume: "Consumo",
  correction: "Correção",
  discard: "Descarte",
};

function StockProductCard({
  product,
  writable,
  busy,
  amount,
  onMove,
  onMissing,
  onArchive,
  onHistory,
}: {
  product: StockProduct;
  writable: boolean;
  busy: boolean;
  amount: string;
  onMove: (kind: "entry" | "consume" | "correction") => void;
  onMissing: () => void;
  onArchive: () => void;
  onHistory: () => void;
}) {
  const status =
    product.state === "missing"
      ? "danger"
      : product.state === "low"
        ? "warning"
        : product.state === "ok"
          ? "success"
          : "neutral";
  return (
    <Card className={product.archived ? "opacity-70" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{product.name}</CardTitle>
            <CardDescription>
              {product.location ? `${product.location} · ` : ""}
              {stockUnitLabel[product.unit]}
            </CardDescription>
          </div>
          <StatusBadge status={status}>{stockStateLabel[product.state]}</StatusBadge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <p className="text-3xl font-semibold tabular-nums">{product.quantity ?? "—"}</p>
          <p className="text-sm text-muted-foreground">
            {product.minimum !== null ? `mín. ${product.minimum}` : "sem mínimo"}
          </p>
        </div>
        {writable && !product.archived ? (
          <div className="grid grid-cols-4 gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => onMove("consume")}
              aria-label={`Consumir ${amount} ${product.name}`}
            >
              <MinusIcon aria-hidden="true" />−
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => onMove("entry")}
              aria-label={`Adicionar ${amount} ${product.name}`}
            >
              <PlusIcon aria-hidden="true" />+
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={busy}
              onClick={() => onMove("correction")}
            >
              Repor
            </Button>
            <Button
              type="button"
              variant={product.markedMissing ? "default" : "outline"}
              className="min-h-11"
              disabled={busy}
              onClick={onMissing}
            >
              {product.markedMissing ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <XIcon aria-hidden="true" />
              )}
              Falta
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{product.note ?? "Quantidade e estado atualizados pelo espaço"}</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onHistory}>
              <HistoryIcon aria-hidden="true" />
              Histórico
            </Button>
            {writable ? (
              <Button type="button" variant="ghost" size="sm" onClick={onArchive}>
                {product.archived ? (
                  <>
                    <RotateCcwIcon aria-hidden="true" />
                    Restaurar
                  </>
                ) : (
                  <>
                    <ArchiveIcon aria-hidden="true" />
                    Arquivar
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
