"use client";

import {
  CalendarClockIcon,
  CheckIcon,
  CreditCardIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PlusIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MoneyInput } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type CreditCard,
  canWriteFinance,
  clearTransactionQueryParams,
  createRequestGuard,
  type FinanceAdapter,
  FinanceAdapterError,
  financeAdapterForEnvironment,
  hasTransactionQueryFilters,
  mergeTransactionPage,
  type Statement,
  type StatementItem,
  shouldRetryIdempotentCommand,
  statementItemAmountPrefix,
  type Transaction,
  transactionQueryFromSearchParams,
} from "@/lib/finance";
import { formatMoneyMinor } from "@/lib/money";
import type { WorkspaceRole } from "@/lib/workspaces";

function transactionLabel(transaction: Transaction): string {
  if (transaction.description.trim()) return transaction.description;
  return transaction.kind === "income" ? "Receita sem descrição" : "Despesa sem descrição";
}

function transactionKindLabel(transaction: Transaction): string {
  if (transaction.kind === "income") return "Receita";
  if (transaction.cardId) return "Compra no cartão";
  return "Despesa";
}

function statementLabel(statement: Statement): string {
  if (statement.state === "open") return "Aberta";
  if (statement.state === "closed") return "Fechada";
  if (statement.state === "paid") return "Paga";
  if (statement.state === "partially_paid") return "Parcialmente paga";
  return "Cancelada";
}

type FinanceDashboardProps = {
  adapter?: FinanceAdapter;
  fixtureMode?: boolean;
  workspaceId: string;
  role: WorkspaceRole;
  currency?: string;
};

function FinanceDashboard({
  adapter: providedAdapter,
  fixtureMode = false,
  workspaceId,
  role,
  currency = "BRL",
}: FinanceDashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [adapter] = useState<FinanceAdapter>(
    () => providedAdapter ?? financeAdapterForEnvironment({ fixtures: fixtureMode }),
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionsNextCursor, setTransactionsNextCursor] = useState<string | null>(null);
  const [transactionsHasMore, setTransactionsHasMore] = useState(false);
  const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transactionType, setTransactionType] = useState<"expense" | "income">("expense");
  const [transactionCardId, setTransactionCardId] = useState("");
  const [amount, setAmount] = useState("0");
  const [description, setDescription] = useState("");
  const [planned, setPlanned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [cardName, setCardName] = useState("");
  const [closingDay, setClosingDay] = useState("10");
  const [dueDay, setDueDay] = useState("17");
  const [savingCard, setSavingCard] = useState(false);
  const [busyStatementId, setBusyStatementId] = useState<string | null>(null);
  const [viewingStatement, setViewingStatement] = useState<Statement | null>(null);
  const [statementItems, setStatementItems] = useState<StatementItem[]>([]);
  const [statementItemsNextCursor, setStatementItemsNextCursor] = useState<string | null>(null);
  const [statementItemsHasMore, setStatementItemsHasMore] = useState(false);
  const [loadingStatementItems, setLoadingStatementItems] = useState(false);
  const [loadingMoreStatementItems, setLoadingMoreStatementItems] = useState(false);
  const [pendingStatementAction, setPendingStatementAction] = useState<{
    type: "close" | "reopen";
    statement: Statement;
  } | null>(null);
  const [statementItemsRequest] = useState(createRequestGuard);
  const [timelineRequest] = useState(createRequestGuard);
  const [timelineSearch, setTimelineSearch] = useState("");
  const [timelineFrom, setTimelineFrom] = useState("");
  const [timelineTo, setTimelineTo] = useState("");
  const [timelineState, setTimelineState] = useState<"" | Transaction["state"]>("");
  const [timelineKind, setTimelineKind] = useState<"" | Transaction["kind"]>("");
  const [undoableTransaction, setUndoableTransaction] = useState<Transaction | null>(null);
  const [undoing, setUndoing] = useState(false);
  const transactionCommandKey = useRef<string | null>(null);
  const transactionCommandWorkspace = useRef(workspaceId);
  const writeAccess = canWriteFinance(role);

  const timelineQuery = useMemo(
    () => transactionQueryFromSearchParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const hasTimelineFilters = hasTransactionQueryFilters(timelineQuery);

  useEffect(() => {
    setTimelineSearch(timelineQuery.search ?? "");
    setTimelineFrom(timelineQuery.from ?? "");
    setTimelineTo(timelineQuery.to ?? "");
    setTimelineState(timelineQuery.state ?? "");
    setTimelineKind(timelineQuery.kind ?? "");
  }, [timelineQuery]);

  useEffect(() => {
    if (!undoableTransaction) return;
    const timeout = window.setTimeout(() => setUndoableTransaction(null), 10_000);
    return () => window.clearTimeout(timeout);
  }, [undoableTransaction]);

  useEffect(() => {
    if (transactionCommandWorkspace.current === workspaceId) return;
    transactionCommandWorkspace.current = workspaceId;
    transactionCommandKey.current = null;
  }, [workspaceId]);

  function updateTimelineQuery(values: {
    search?: string;
    from?: string;
    to?: string;
    state?: string;
    kind?: string;
    cursor?: string | null;
  }) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    if (!("cursor" in values)) params.delete("cursor");
    const query = params.toString();
    router.replace(`/app/finances${query ? `?${query}` : ""}`, { scroll: false });
  }

  const load = useCallback(
    async (append = false) => {
      const request = timelineRequest.begin();
      setStatus("loading");
      setError(null);
      setViewingStatement(null);
      setStatementItems([]);
      setStatementItemsNextCursor(null);
      setStatementItemsHasMore(false);
      try {
        const [nextTransactions, nextCards, nextStatements] = await Promise.all([
          adapter.listTransactions(workspaceId, { ...timelineQuery, limit: 50 }),
          adapter.listCards(workspaceId),
          adapter.listStatements(workspaceId),
        ]);
        if (!timelineRequest.isCurrent(request)) return;
        setTransactions((current) => mergeTransactionPage(current, nextTransactions, append));
        setTransactionsNextCursor(nextTransactions.nextCursor);
        setTransactionsHasMore(nextTransactions.hasMore);
        setCards(nextCards);
        setStatements(nextStatements);
        setStatus("success");
      } catch (cause) {
        if (!timelineRequest.isCurrent(request)) return;
        setStatus("error");
        setError(
          cause instanceof Error ? cause.message : "Não foi possível carregar suas finanças.",
        );
      }
    },
    [adapter, timelineQuery, timelineRequest, workspaceId],
  );

  useEffect(() => {
    void load(Boolean(timelineQuery.cursor));
  }, [load, timelineQuery.cursor]);

  const walletTotal = useMemo(
    () =>
      transactions.reduce((total, transaction) => {
        if (transaction.state !== "posted" || transaction.cardId) return total;
        const value = BigInt(transaction.amount.minor);
        return total + (transaction.kind === "income" ? value : -value);
      }, BigInt(0)),
    [transactions],
  );

  async function handleTransactionSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || BigInt(amount || "0") <= BigInt(0)) {
      setError("Informe um valor maior que zero.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const commandKey = transactionCommandKey.current ?? `web-${crypto.randomUUID()}`;
    transactionCommandKey.current = commandKey;
    try {
      const created = await adapter.createTransaction(
        workspaceId,
        {
          kind: transactionType,
          amount: { currency, minor: amount },
          state: planned ? "planned" : "posted",
          description,
          cardId: transactionCardId || null,
        },
        commandKey,
      );
      transactionCommandKey.current = null;
      setAmount("0");
      setDescription("");
      setTransactionCardId("");
      setPlanned(false);
      if (timelineQuery.cursor) updateTimelineQuery({ cursor: null });
      else await load(false);
      setNotice(planned ? "Compromisso salvo." : "Lançamento salvo.");
      setUndoableTransaction(planned ? null : created);
    } catch (cause) {
      if (!shouldRetryIdempotentCommand(cause)) transactionCommandKey.current = null;
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o lançamento.");
    } finally {
      setSaving(false);
    }
  }

  async function undoTransaction() {
    if (!undoableTransaction || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      await adapter.reverseTransaction(workspaceId, undoableTransaction);
      setUndoableTransaction(null);
      if (timelineQuery.cursor) updateTimelineQuery({ cursor: null });
      else await load(false);
      setNotice("Lançamento desfeito.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível desfazer o lançamento.");
    } finally {
      setUndoing(false);
    }
  }

  function applyTimelineFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateTimelineQuery({
      search: timelineSearch.trim(),
      from: timelineFrom,
      to: timelineTo,
      state: timelineState,
      kind: timelineKind,
    });
  }

  function clearTimelineFilters() {
    setTimelineSearch("");
    setTimelineFrom("");
    setTimelineTo("");
    setTimelineState("");
    setTimelineKind("");
    const params = clearTransactionQueryParams(new URLSearchParams(searchParams.toString()));
    const query = params.toString();
    router.replace(`/app/finances${query ? `?${query}` : ""}`, { scroll: false });
  }

  async function handleCardSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingCard || !cardName.trim()) return;
    setSavingCard(true);
    setError(null);
    try {
      const card = await adapter.createCard(workspaceId, {
        name: cardName.trim(),
        closingDay: Number(closingDay),
        dueDay: Number(dueDay),
      });
      setCards((current) => [...current, card]);
      setCardName("");
      setShowCardForm(false);
      setNotice("Cartão cadastrado.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível cadastrar o cartão.");
    } finally {
      setSavingCard(false);
    }
  }

  async function runStatementAction(type: "close" | "reopen", statement: Statement) {
    if (busyStatementId) return;
    setBusyStatementId(statement.id);
    setError(null);
    try {
      const updated =
        type === "close"
          ? await adapter.closeStatement(workspaceId, statement)
          : await adapter.reopenStatement(workspaceId, statement);
      setStatements((current) =>
        current.map((value) => (value.id === updated.id ? updated : value)),
      );
      setPendingStatementAction(null);
      setNotice(
        type === "close"
          ? "Fatura fechada. Compras novas entram no próximo ciclo."
          : "Fatura reaberta. Novos lançamentos podem voltar a compor este ciclo.",
      );
    } catch (cause) {
      if (cause instanceof FinanceAdapterError && cause.status === 412) {
        setPendingStatementAction(null);
        await load();
        setNotice(
          "A fatura mudou enquanto você revisava. Recarregamos os dados; revise antes de tentar novamente.",
        );
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : `Não foi possível ${type === "close" ? "fechar" : "reabrir"} a fatura.`,
      );
    } finally {
      setBusyStatementId(null);
    }
  }

  const viewingStatementId = viewingStatement?.id;

  const loadStatementItems = useCallback(
    async (statementId: string, cursor: string | undefined, append: boolean) => {
      const request = statementItemsRequest.begin();
      if (append) {
        setLoadingMoreStatementItems(true);
      } else {
        setStatementItems([]);
        setStatementItemsNextCursor(null);
        setStatementItemsHasMore(false);
        setLoadingStatementItems(true);
      }
      setError(null);
      try {
        const page = await adapter.listStatementItems(workspaceId, statementId, {
          cursor,
          limit: 50,
        });
        if (!statementItemsRequest.isCurrent(request)) return;
        setStatementItems((current) => (append ? [...current, ...page.items] : page.items));
        setStatementItemsNextCursor(page.nextCursor);
        setStatementItemsHasMore(page.hasMore);
      } catch (cause) {
        if (!statementItemsRequest.isCurrent(request)) return;
        setError(
          cause instanceof Error ? cause.message : "Não foi possível carregar a composição.",
        );
        if (!append) setViewingStatement(null);
      } finally {
        if (statementItemsRequest.isCurrent(request)) {
          if (append) {
            setLoadingMoreStatementItems(false);
          } else {
            setLoadingStatementItems(false);
          }
        }
      }
    },
    [adapter, statementItemsRequest, workspaceId],
  );

  useEffect(() => {
    if (!viewingStatementId) {
      statementItemsRequest.invalidate();
      setStatementItems([]);
      setStatementItemsNextCursor(null);
      setStatementItemsHasMore(false);
      setLoadingStatementItems(false);
      setLoadingMoreStatementItems(false);
      return;
    }
    void loadStatementItems(viewingStatementId, undefined, false);
    return () => statementItemsRequest.invalidate();
  }, [loadStatementItems, statementItemsRequest, viewingStatementId]);

  async function payStatement(statement: Statement) {
    if (busyStatementId || BigInt(statement.openAmount.minor) <= BigInt(0)) return;
    setBusyStatementId(statement.id);
    setError(null);
    try {
      await adapter.payStatement(workspaceId, statement);
      await load();
      setNotice("Pagamento registrado na carteira.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível pagar a fatura.");
    } finally {
      setBusyStatementId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Carteira e compromissos</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Finanças</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Registre o essencial agora. Faturas, parcelas e compromissos ficam no mesmo lugar.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={status === "loading"}>
          <RefreshCwIcon aria-hidden="true" /> Atualizar
        </Button>
      </header>

      {notice ? (
        <Alert role="status">
          <CheckIcon aria-hidden="true" />
          <AlertTitle>{notice}</AlertTitle>
          <AlertDescription>
            <span className="flex flex-wrap items-center gap-3">
              <span>Você pode continuar registrando ou revisar a linha do tempo abaixo.</span>
              {undoableTransaction ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void undoTransaction()}
                  disabled={undoing || !writeAccess}
                >
                  {undoing ? "Desfazendo…" : "Desfazer"}
                </Button>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Não foi possível concluir</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3" aria-label="Resumo financeiro">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader>
            <CardDescription className="text-primary-foreground/70">
              Saldo dos lançamentos carregados
            </CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {formatMoneyMinor(walletTotal.toString(), currency)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-primary-foreground/80">
            A linha do tempo é paginada; aplique filtros ou carregue mais para revisar os dados.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Valor seguro para gastar</CardDescription>
            <CardTitle className="text-2xl font-semibold">Ainda não calculado</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Registre saldo inicial e compromissos para aumentar a confiança.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Cartões ativos</CardDescription>
            <CardTitle className="text-3xl font-semibold">
              {cards.filter((card) => !card.archived).length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Compras no cartão não reduzem o saldo até o pagamento da fatura.
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="quick-entry-title">
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <ReceiptTextIcon aria-hidden="true" />
              <div>
                <CardTitle id="quick-entry-title">Adicionar lançamento</CardTitle>
                <CardDescription>Valor é o único campo obrigatório.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-[auto_auto_1fr_1.4fr_auto] md:items-end"
              onSubmit={handleTransactionSubmit}
            >
              <Field>
                <FieldLabel htmlFor="transaction-kind">Tipo</FieldLabel>
                <select
                  id="transaction-kind"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={transactionType}
                  onChange={(event) =>
                    setTransactionType(event.target.value as "expense" | "income")
                  }
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="transaction-instrument">Onde?</FieldLabel>
                <select
                  id="transaction-instrument"
                  className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={transactionCardId}
                  disabled={transactionType === "income"}
                  onChange={(event) => setTransactionCardId(event.target.value)}
                >
                  <option value="">Carteira</option>
                  {cards
                    .filter((card) => !card.archived)
                    .map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.name}
                      </option>
                    ))}
                </select>
              </Field>
              <MoneyInput value={amount} onChange={setAmount} label="Valor" currency={currency} />
              <Field>
                <FieldLabel htmlFor="transaction-description">Descrição (opcional)</FieldLabel>
                <Input
                  id="transaction-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Ex.: mercado"
                  maxLength={500}
                />
                <FieldDescription>Você pode detalhar depois.</FieldDescription>
              </Field>
              <div className="flex flex-col gap-2">
                <label className="flex min-h-8 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={planned}
                    onChange={(event) => setPlanned(event.target.checked)}
                  />{" "}
                  Planejada
                </label>
                <Button type="submit" disabled={saving || !writeAccess}>
                  {saving ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <PlusIcon aria-hidden="true" />
                  )}
                  Salvar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Linha do tempo</CardTitle>
            <CardDescription>
              Entradas, saídas e compromissos do espaço. Filtros ficam salvos neste endereço.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="mb-5 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-3"
              onSubmit={applyTimelineFilters}
              aria-label="Filtrar linha do tempo"
            >
              <Field className="sm:col-span-2 lg:col-span-3">
                <FieldLabel htmlFor="timeline-search">Buscar por descrição</FieldLabel>
                <div className="relative">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id="timeline-search"
                    value={timelineSearch}
                    onChange={(event) => setTimelineSearch(event.target.value)}
                    placeholder="Ex.: mercado"
                    className="pl-9"
                    maxLength={100}
                  />
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-from">De</FieldLabel>
                <Input
                  id="timeline-from"
                  type="date"
                  value={timelineFrom}
                  onChange={(event) => setTimelineFrom(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-to">Até</FieldLabel>
                <Input
                  id="timeline-to"
                  type="date"
                  value={timelineTo}
                  onChange={(event) => setTimelineTo(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-state">Estado</FieldLabel>
                <select
                  id="timeline-state"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={timelineState}
                  onChange={(event) =>
                    setTimelineState(event.target.value as "" | Transaction["state"])
                  }
                >
                  <option value="">Todos</option>
                  <option value="posted">Realizadas</option>
                  <option value="planned">Planejadas</option>
                  <option value="partially_settled">Parciais</option>
                  <option value="canceled">Canceladas</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="timeline-kind">Tipo</FieldLabel>
                <select
                  id="timeline-kind"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                  value={timelineKind}
                  onChange={(event) =>
                    setTimelineKind(event.target.value as "" | Transaction["kind"])
                  }
                >
                  <option value="">Todos</option>
                  <option value="expense">Despesas</option>
                  <option value="income">Receitas</option>
                  <option value="transfer">Transferências</option>
                  <option value="adjustment">Ajustes</option>
                </select>
              </Field>
              <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm">
                  <SearchIcon aria-hidden="true" /> Aplicar filtros
                </Button>
                {hasTimelineFilters ? (
                  <Button type="button" size="sm" variant="ghost" onClick={clearTimelineFilters}>
                    <XIcon aria-hidden="true" /> Limpar
                  </Button>
                ) : null}
              </div>
            </form>
            {status === "loading" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Carregando lançamentos…
              </p>
            ) : transactions.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                {hasTimelineFilters
                  ? "Nenhum lançamento corresponde aos filtros. Tente limpar ou ampliar o período."
                  : "Nenhum lançamento ainda. Comece pelo valor acima."}
              </p>
            ) : (
              <>
                <ul className="divide-y">
                  {transactions.map((transaction) => (
                    <li
                      key={transaction.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{transactionLabel(transaction)}</p>
                        <p className="text-sm text-muted-foreground">
                          {transactionKindLabel(transaction)} · {transaction.occurredOn} ·{" "}
                          {transaction.state === "planned"
                            ? "Planejada"
                            : transaction.state === "canceled"
                              ? "Cancelada"
                              : transaction.state === "partially_settled"
                                ? "Parcial"
                                : "Realizada"}
                        </p>
                      </div>
                      <span
                        className={
                          transaction.state === "canceled"
                            ? "font-semibold text-muted-foreground line-through"
                            : transaction.kind === "income"
                              ? "font-semibold text-emerald-700"
                              : "font-semibold text-foreground"
                        }
                      >
                        {transaction.kind === "income" ? "+" : "−"}
                        {formatMoneyMinor(transaction.amount.minor, transaction.amount.currency)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewingTransaction(transaction)}
                        aria-label={`Ver detalhes de ${transactionLabel(transaction)}`}
                      >
                        Detalhes
                      </Button>
                    </li>
                  ))}
                </ul>
                {transactionsHasMore ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => updateTimelineQuery({ cursor: transactionsNextCursor })}
                    disabled={!transactionsNextCursor}
                  >
                    Carregar mais lançamentos
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <CreditCardIcon aria-hidden="true" />
                <div>
                  <CardTitle>Cartões e faturas</CardTitle>
                  <CardDescription>O dinheiro sai só quando a fatura é paga.</CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCardForm((value) => !value)}
                aria-expanded={showCardForm}
                disabled={!writeAccess}
              >
                <PlusIcon aria-hidden="true" /> Cartão
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {showCardForm ? (
              <form
                className="grid gap-3 rounded-lg border bg-muted/30 p-3"
                onSubmit={handleCardSubmit}
              >
                <Field>
                  <FieldLabel htmlFor="card-name">Nome do cartão</FieldLabel>
                  <Input
                    id="card-name"
                    value={cardName}
                    onChange={(event) => setCardName(event.target.value)}
                    required
                    placeholder="Ex.: Cartão principal"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="card-closing">Fecha dia</FieldLabel>
                    <Input
                      id="card-closing"
                      type="number"
                      min={1}
                      max={31}
                      value={closingDay}
                      onChange={(event) => setClosingDay(event.target.value)}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="card-due">Vence dia</FieldLabel>
                    <Input
                      id="card-due"
                      type="number"
                      min={1}
                      max={31}
                      value={dueDay}
                      onChange={(event) => setDueDay(event.target.value)}
                      required
                    />
                  </Field>
                </div>
                <Button type="submit" disabled={savingCard}>
                  {savingCard ? "Salvando…" : "Salvar cartão"}
                </Button>
              </form>
            ) : null}
            {cards.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum cartão cadastrado.</p>
            ) : null}
            {cards.map((card) => (
              <div key={card.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{card.name}</p>
                  <span className="text-sm text-muted-foreground">
                    Fecha {card.closingDay} · vence {card.dueDay}
                  </span>
                </div>
                {statements
                  .filter((statement) => statement.cardId === card.id)
                  .map((statement) => (
                    <div
                      key={statement.id}
                      className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm"
                    >
                      <div>
                        <p className="font-medium">Fatura até {statement.closingOn}</p>
                        <p className="text-muted-foreground">
                          {statementLabel(statement)} · vence {statement.dueOn}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">
                          {formatMoneyMinor(
                            statement.openAmount.minor,
                            statement.openAmount.currency,
                          )}
                        </p>
                        <div className="mt-1 flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setViewingStatement(statement)}
                          >
                            <ListTreeIcon data-icon="inline-start" aria-hidden="true" />
                            Composição
                          </Button>
                          {statement.state === "open" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() =>
                                setPendingStatementAction({ type: "close", statement })
                              }
                            >
                              Fechar
                            </Button>
                          ) : null}
                          {statement.state === "closed" &&
                          BigInt(statement.paid.minor) === BigInt(0) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() =>
                                setPendingStatementAction({ type: "reopen", statement })
                              }
                            >
                              <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                              Reabrir
                            </Button>
                          ) : null}
                          {statement.state !== "paid" &&
                          statement.state !== "canceled" &&
                          BigInt(statement.openAmount.minor) > BigInt(0) ? (
                            <Button
                              size="sm"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() => void payStatement(statement)}
                            >
                              {busyStatementId === statement.id ? "Pagando…" : "Pagar"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Card id="safe-to-spend">
        <CardHeader>
          <div className="flex items-start gap-3">
            <CalendarClockIcon aria-hidden="true" />
            <div>
              <CardTitle>Planejamento</CardTitle>
              <CardDescription>
                Recorrências e parcelamentos entram como compromissos sem alterar o saldo antes da
                hora.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-dashed p-4">
            <p className="font-medium">Recorrências</p>
            <p className="mt-1 text-sm text-muted-foreground">
              O cadastro da regra já está disponível na API; a tela dedicada será adicionada junto
              da confirmação de valores variáveis.
            </p>
          </div>
          <div className="rounded-lg border border-dashed p-4">
            <p className="font-medium">Parcelamentos</p>
            <p className="mt-1 text-sm text-muted-foreground">
              As parcelas são calculadas em centavos exatos no servidor antes de publicar o plano.
            </p>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={viewingTransaction !== null}
        onOpenChange={(open) => {
          if (!open) setViewingTransaction(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Detalhes do lançamento</DialogTitle>
            <DialogDescription>
              Revise a origem, o estado e a versão antes de corrigir este registro.
            </DialogDescription>
          </DialogHeader>
          {viewingTransaction ? (
            <dl className="grid gap-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Descrição</dt>
                <dd className="mt-1 font-medium">{transactionLabel(viewingTransaction)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Tipo</dt>
                <dd className="mt-1 font-medium">{transactionKindLabel(viewingTransaction)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Valor</dt>
                <dd className="mt-1 font-medium">
                  {viewingTransaction.kind === "income" ? "+" : "−"}
                  {formatMoneyMinor(
                    viewingTransaction.amount.minor,
                    viewingTransaction.amount.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Estado</dt>
                <dd className="mt-1 font-medium">
                  {viewingTransaction.state === "posted"
                    ? "Realizada"
                    : viewingTransaction.state === "planned"
                      ? "Planejada"
                      : viewingTransaction.state === "partially_settled"
                        ? "Parcial"
                        : "Cancelada"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Data do fato</dt>
                <dd className="mt-1 font-medium">{viewingTransaction.occurredOn}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Versão auditável</dt>
                <dd className="mt-1 font-medium">v{viewingTransaction.version}</dd>
              </div>
            </dl>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Fechar</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={viewingStatement !== null}
        onOpenChange={(open) => {
          if (!open) setViewingStatement(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Composição da fatura</DialogTitle>
            <DialogDescription>
              Compras aumentam o total. Pagamentos reduzem apenas o valor em aberto.
            </DialogDescription>
          </DialogHeader>
          {viewingStatement ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(
                      viewingStatement.total.minor,
                      viewingStatement.total.currency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Pago</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(viewingStatement.paid.minor, viewingStatement.paid.currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Em aberto</dt>
                  <dd className="mt-1 font-semibold">
                    {formatMoneyMinor(
                      viewingStatement.openAmount.minor,
                      viewingStatement.openAmount.currency,
                    )}
                  </dd>
                </div>
              </dl>
              {loadingStatementItems ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Carregando composição…
                </p>
              ) : statementItems.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Esta fatura ainda não possui compras nem pagamentos.
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto">
                  {statementItems.map((item) => {
                    const canceled = item.state === "canceled";
                    const kindLabel = item.type === "payment" ? "Pagamento" : "Compra";
                    return (
                      <li
                        key={item.id}
                        className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {item.description ||
                              (item.type === "payment" ? "Pagamento de fatura" : "Compra")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {kindLabel}
                            {canceled ? " cancelada" : ""} · {item.occurredOn}
                          </p>
                        </div>
                        <span
                          className={
                            canceled
                              ? "shrink-0 text-sm text-muted-foreground line-through"
                              : "shrink-0 font-semibold"
                          }
                        >
                          {statementItemAmountPrefix(item)}
                          {formatMoneyMinor(item.amount.minor, item.amount.currency)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {statementItemsHasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  disabled={loadingMoreStatementItems || loadingStatementItems}
                  onClick={() => {
                    if (statementItemsNextCursor && viewingStatementId) {
                      void loadStatementItems(viewingStatementId, statementItemsNextCursor, true);
                    }
                  }}
                >
                  {loadingMoreStatementItems ? "Carregando mais…" : "Carregar mais itens"}
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Fechar</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingStatementAction !== null}
        onOpenChange={(open) => {
          if (!open && busyStatementId === null) setPendingStatementAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingStatementAction?.type === "reopen" ? "Reabrir fatura?" : "Fechar fatura?"}
            </DialogTitle>
            <DialogDescription>
              {pendingStatementAction?.type === "reopen"
                ? "Esta fatura voltará a aceitar lançamentos. A reabertura é bloqueada quando já existem pagamentos."
                : "O período e o total ficam congelados. Novas compras serão direcionadas para o próximo ciclo."}
            </DialogDescription>
          </DialogHeader>
          {pendingStatementAction ? (
            <p className="rounded-lg bg-muted/50 p-3 text-sm">
              Fatura com vencimento em {pendingStatementAction.statement.dueOn} · valor em aberto{" "}
              <strong>
                {formatMoneyMinor(
                  pendingStatementAction.statement.openAmount.minor,
                  pendingStatementAction.statement.openAmount.currency,
                )}
              </strong>
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />} disabled={busyStatementId !== null}>
              Cancelar
            </DialogClose>
            <Button
              disabled={busyStatementId !== null}
              onClick={() => {
                if (pendingStatementAction) {
                  void runStatementAction(
                    pendingStatementAction.type,
                    pendingStatementAction.statement,
                  );
                }
              }}
            >
              {busyStatementId
                ? "Salvando…"
                : pendingStatementAction?.type === "reopen"
                  ? "Reabrir fatura"
                  : "Fechar fatura"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function FinancesPage() {
  const { workspaceId, role, fixtureMode, currency } = useAuthenticatedWorkspace();
  return (
    <FinanceDashboard
      workspaceId={workspaceId}
      role={role}
      fixtureMode={fixtureMode}
      currency={currency}
    />
  );
}
