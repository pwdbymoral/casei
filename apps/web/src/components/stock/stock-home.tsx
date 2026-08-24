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
  ShoppingCartIcon,
  XIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AsyncState, StatusBadge } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  canWriteStock,
  type StockAdapter,
  StockAdapterError,
  type StockMovement,
  type StockMovementKind,
  type StockProduct,
  type StockShoppingItem,
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
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [shoppingItems, setShoppingItems] = useState<StockShoppingItem[]>([]);
  const [viewMode, setViewMode] = useState<"shopping" | "missing" | "all">("shopping");
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
  const [newUnitLabel, setNewUnitLabel] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [newMinimum, setNewMinimum] = useState("");
  const [newShoppingAuto, setNewShoppingAuto] = useState(true);
  const [newCategory, setNewCategory] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newNote, setNewNote] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<StockProduct | null>(null);
  const [history, setHistory] = useState<StockMovement[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const writable = canWriteStock(role) && status !== "offline";
  const [freeItemName, setFreeItemName] = useState("");
  const [freeItemQuantity, setFreeItemQuantity] = useState("");
  const [selectedShoppingIds, setSelectedShoppingIds] = useState<string[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutDraft, setCheckoutDraft] = useState<
    Record<string, { addToStock: boolean; quantity: string }>
  >({});
  const generation = useRef(0);
  const mutationToken = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setStatus("loading");
    setError(null);
    try {
      const [next, nextShopping] = await Promise.all([
        adapter.listProducts(workspaceId, { query, includeArchived: showArchived }),
        adapter.listShoppingItems(workspaceId),
      ]);
      if (current !== generation.current) return;
      setProducts(next);
      setShoppingItems(nextShopping);
      setStatus(
        adapter.lastReadWasCached || globalThis.navigator?.onLine === false
          ? "offline"
          : next.length
            ? "success"
            : "empty",
      );
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o estoque.");
      setStatus(
        cause instanceof StockAdapterError && cause.code === "offline_required"
          ? "offline"
          : "error",
      );
    }
  }, [adapter, query, showArchived, workspaceId]);

  useEffect(() => {
    setProducts([]);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  async function mutate(key: string, operation: (idempotencyKey: string) => Promise<unknown>) {
    const requestGeneration = generation.current;
    const currentMutation = ++mutationToken.current;
    const operationKey = `stock-${globalThis.crypto.randomUUID()}`;
    setBusy(key);
    setError(null);
    try {
      await operation(operationKey);
      if (requestGeneration === generation.current && currentMutation === mutationToken.current)
        await load();
    } catch (cause) {
      if (requestGeneration === generation.current && currentMutation === mutationToken.current) {
        if (cause instanceof StockAdapterError && cause.code === "offline_required")
          setStatus("offline");
        setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o estoque.");
      }
    } finally {
      if (currentMutation === mutationToken.current) setBusy(null);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim()) return;
    await mutate("new", async (operationKey) => {
      const product = await adapter.createProduct(
        workspaceId,
        {
          name: newName,
          unit: newUnit,
          unitLabel: newUnit === "other" ? newUnitLabel || null : null,
          quantity: newQuantity || null,
          minimum: newMinimum || null,
          shoppingAuto: newShoppingAuto,
          category: newCategory || null,
          location: newLocation || null,
          note: newNote || null,
        },
        operationKey,
      );
      setNewName("");
      setNewUnitLabel("");
      setNewQuantity("");
      setNewMinimum("");
      setNewShoppingAuto(true);
      setNewCategory("");
      setNewLocation("");
      setNewNote("");
      setDetailsOpen(false);
      setNewProductOpen(false);
      return product;
    });
  }

  async function createFreeShoppingItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!freeItemName.trim()) return;
    await mutate("shopping-new", async () => {
      const item = await adapter.createShoppingItem(workspaceId, {
        name: freeItemName,
        quantity: freeItemQuantity || null,
      });
      setFreeItemName("");
      setFreeItemQuantity("");
      return item;
    });
  }

  function selectShoppingItem(item: StockShoppingItem) {
    setSelectedShoppingIds((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    );
  }

  function openCheckout() {
    const selected = shoppingItems.filter((item) => selectedShoppingIds.includes(item.id));
    setCheckoutDraft(
      Object.fromEntries(
        selected.map((item) => [
          item.id,
          { addToStock: item.source === "automatic", quantity: item.quantity ?? "" },
        ]),
      ),
    );
    setCheckoutOpen(true);
  }

  async function finalizeShopping() {
    const selected = shoppingItems.filter((item) => selectedShoppingIds.includes(item.id));
    setBusy("shopping-checkout");
    setError(null);
    try {
      for (const item of selected) {
        const draft = checkoutDraft[item.id] ?? { addToStock: false, quantity: "" };
        await adapter.purchaseShoppingItem(workspaceId, item, {
          addToStock: draft.addToStock,
          quantity: draft.quantity || null,
        });
      }
      setSelectedShoppingIds([]);
      setCheckoutOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível finalizar a compra.");
    } finally {
      setBusy(null);
    }
  }

  async function quick(product: StockProduct, kind: "entry" | "consume" | "correction") {
    const quantity = kind === "correction" ? amount : amount || "1";
    await mutate(product.id, (operationKey) =>
      adapter.createMovement(workspaceId, product, { kind, quantity }, operationKey),
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

  const visibleProducts =
    viewMode === "all"
      ? products
      : products.filter((product) => product.state === "missing" || product.state === "low");
  const visibleShoppingItems = shoppingItems.filter((item) =>
    item.name.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")),
  );
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
              {newUnit === "other" ? (
                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="stock-new-unit-label">Rótulo da unidade</Label>
                  <Input
                    id="stock-new-unit-label"
                    value={newUnitLabel}
                    onChange={(event) => setNewUnitLabel(event.target.value)}
                    placeholder="Ex.: garrafa"
                    required
                  />
                </div>
              ) : null}
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
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <div className="grid gap-1">
                      <Label htmlFor="stock-new-category">Categoria</Label>
                      <Input
                        id="stock-new-category"
                        value={newCategory}
                        onChange={(event) => setNewCategory(event.target.value)}
                        placeholder="Despensa"
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor="stock-new-location">Local</Label>
                      <Input
                        id="stock-new-location"
                        value={newLocation}
                        onChange={(event) => setNewLocation(event.target.value)}
                        placeholder="Armário"
                      />
                    </div>
                    <div className="grid gap-1 sm:col-span-1">
                      <Label htmlFor="stock-new-note">Observação</Label>
                      <Input
                        id="stock-new-note"
                        value={newNote}
                        onChange={(event) => setNewNote(event.target.value)}
                        placeholder="Opcional"
                      />
                    </div>
                    <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-3">
                      <input
                        type="checkbox"
                        checked={newShoppingAuto}
                        onChange={(event) => setNewShoppingAuto(event.target.checked)}
                      />
                      Sugerir na lista quando estiver faltando ou abaixo do mínimo
                    </label>
                  </div>
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

      <nav className="flex flex-wrap gap-2" aria-label="Visão da casa">
        {(
          [
            ["shopping", "Lista de compras"],
            ["missing", "Faltando"],
            ["all", "Todos"],
          ] as const
        ).map(([mode, label]) => (
          <Button
            key={mode}
            type="button"
            size="sm"
            variant={viewMode === mode ? "default" : "outline"}
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
          >
            {mode === "shopping" ? <ShoppingCartIcon aria-hidden="true" /> : null}
            {label}
            {mode === "shopping" ? ` (${visibleShoppingItems.length})` : null}
          </Button>
        ))}
      </nav>

      {viewMode === "shopping" && status !== "loading" ? (
        <section aria-labelledby="shopping-title" className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 id="shopping-title" className="text-xl font-semibold">
                Lista de compras
              </h3>
              <p className="text-sm text-muted-foreground">
                Faltantes e itens baixos entram automaticamente; itens livres ficam separados do
                estoque.
              </p>
            </div>
            {selectedShoppingIds.length > 0 ? (
              <Button type="button" onClick={openCheckout} className="min-h-11">
                <CheckIcon aria-hidden="true" /> Finalizar compra ({selectedShoppingIds.length})
              </Button>
            ) : null}
          </div>
          {writable ? (
            <form
              onSubmit={createFreeShoppingItem}
              className="flex flex-col gap-2 sm:flex-row"
              aria-label="Adicionar item livre"
            >
              <Label htmlFor="shopping-free-name" className="sr-only">
                Item livre
              </Label>
              <Input
                id="shopping-free-name"
                value={freeItemName}
                onChange={(event) => setFreeItemName(event.target.value)}
                placeholder="Adicionar item que não está no estoque"
                className="min-h-11 flex-1"
              />
              <Label htmlFor="shopping-free-quantity" className="sr-only">
                Quantidade do item livre
              </Label>
              <Input
                id="shopping-free-quantity"
                inputMode="decimal"
                value={freeItemQuantity}
                onChange={(event) => setFreeItemQuantity(event.target.value)}
                placeholder="Qtd. (opcional)"
                className="min-h-11 sm:w-32"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={busy === "shopping-new"}
                className="min-h-11"
              >
                Adicionar
              </Button>
            </form>
          ) : null}
          {visibleShoppingItems.length === 0 ? (
            <AsyncState
              status="empty"
              title="Lista vazia"
              description="Nada em falta por enquanto. Você também pode adicionar um item livre acima."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleShoppingItems.map((item) => {
                const selected = selectedShoppingIds.includes(item.id);
                return (
                  <Card key={item.id} className={selected ? "ring-2 ring-ring" : undefined}>
                    <CardContent className="flex min-h-20 items-center gap-3 p-4">
                      <input
                        type="checkbox"
                        className="size-5 shrink-0"
                        checked={selected}
                        onChange={() => selectShoppingItem(item)}
                        aria-label={`Selecionar ${item.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium break-words">{item.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {item.quantity ?? "Quantidade a definir"}{" "}
                          {item.unitLabel ?? stockUnitLabel[item.unit]}
                          {item.source === "automatic" ? " · do estoque" : " · item livre"}
                        </p>
                      </div>
                      {item.lastChangedBy ? (
                        <span className="sr-only">Alterado por {item.lastChangedBy}</span>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {error ? (
        <AsyncState
          status="error"
          title="Não foi possível atualizar o estoque"
          description={error}
          action={{ label: "Tentar novamente", onClick: () => void load() }}
        />
      ) : null}
      {status === "loading" ? <AsyncState status="loading" /> : null}
      {status === "empty" && viewMode !== "shopping" ? (
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
      {status === "offline" ? (
        <AsyncState
          status="offline"
          title="Você está offline"
          description="Mostrando o último snapshot salvo. Adicionar, movimentar ou arquivar exige conexão."
        />
      ) : null}
      {status !== "loading" && viewMode !== "shopping" ? (
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
                void mutate(product.id, (operationKey) =>
                  adapter.markMissing(workspaceId, product, !product.markedMissing, operationKey),
                )
              }
              onArchive={() =>
                void mutate(product.id, (operationKey) =>
                  product.archived
                    ? adapter.restore(workspaceId, product, operationKey)
                    : adapter.archive(workspaceId, product, operationKey),
                )
              }
              onHistory={() => void openHistory(product)}
            />
          ))}
        </div>
      ) : null}
      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Finalizar compra</DialogTitle>
            <DialogDescription>
              Marcar como comprado não altera o estoque. Confirme, por item, quais quantidades devem
              ser adicionadas.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
            {shoppingItems
              .filter((item) => selectedShoppingIds.includes(item.id))
              .map((item) => {
                const draft = checkoutDraft[item.id] ?? {
                  addToStock: false,
                  quantity: item.quantity ?? "",
                };
                return (
                  <div key={item.id} className="rounded-lg border p-3">
                    <p className="font-medium">{item.name}</p>
                    {item.source === "automatic" ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem] sm:items-end">
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.addToStock}
                            onChange={(event) =>
                              setCheckoutDraft((current) => ({
                                ...current,
                                [item.id]: { ...draft, addToStock: event.target.checked },
                              }))
                            }
                          />
                          Adicionar ao estoque
                        </label>
                        <div className="grid gap-1">
                          <Label htmlFor={`checkout-quantity-${item.id}`}>Quantidade</Label>
                          <Input
                            id={`checkout-quantity-${item.id}`}
                            inputMode="decimal"
                            value={draft.quantity}
                            onChange={(event) =>
                              setCheckoutDraft((current) => ({
                                ...current,
                                [item.id]: { ...draft, quantity: event.target.value },
                              }))
                            }
                            disabled={!draft.addToStock}
                          />
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Item livre: a compra será registrada sem alterar o estoque.
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCheckoutOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void finalizeShopping()}
              disabled={busy === "shopping-checkout"}
            >
              {busy === "shopping-checkout" ? "Salvando…" : "Confirmar compra"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                      {historyProduct.unit === "other"
                        ? (historyProduct.unitLabel ?? "outra unidade")
                        : stockUnitLabel[historyProduct.unit]}
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
              {product.unit === "other"
                ? (product.unitLabel ?? "outra unidade")
                : stockUnitLabel[product.unit]}
              {product.category ? ` · ${product.category}` : ""}
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
