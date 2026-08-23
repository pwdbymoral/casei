"use client";

import {
  CalendarClockIcon,
  CheckIcon,
  CreditCardIcon,
  LoaderCircleIcon,
  PlusIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MoneyInput } from "@/components/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type CreditCard,
  canWriteFinance,
  type FinanceAdapter,
  financeAdapterForEnvironment,
  type Statement,
  type Transaction,
} from "@/lib/finance";
import { formatMoneyMinor } from "@/lib/money";
import type { WorkspaceRole } from "@/lib/workspaces";

const fixtureWorkspaceId = "019b5d9e-3c12-7a01-8d47-7b5b5dd7a201";
const activeWorkspaceStorageKey = "casei:active-workspace:v1";

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function activeWorkspaceId(): string {
  if (typeof window === "undefined") return fixtureWorkspaceId;
  return window.localStorage.getItem(activeWorkspaceStorageKey) ?? fixtureWorkspaceId;
}

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

export type FinanceDashboardProps = {
  adapter?: FinanceAdapter;
  workspaceId?: string;
  role?: WorkspaceRole;
};

export function FinanceDashboard({
  adapter: providedAdapter,
  workspaceId: providedWorkspaceId,
  role = "owner",
}: FinanceDashboardProps = {}) {
  const [adapter] = useState<FinanceAdapter>(
    () => providedAdapter ?? financeAdapterForEnvironment(),
  );
  const [workspaceId, setWorkspaceId] = useState(providedWorkspaceId ?? fixtureWorkspaceId);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
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
  const writeAccess = canWriteFinance(role);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [nextTransactions, nextCards, nextStatements] = await Promise.all([
        adapter.listTransactions(workspaceId),
        adapter.listCards(workspaceId),
        adapter.listStatements(workspaceId),
      ]);
      setTransactions(nextTransactions);
      setCards(nextCards);
      setStatements(nextStatements);
      setStatus("success");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar suas finanças.");
    }
  }, [adapter, workspaceId]);

  useEffect(() => {
    if (!providedWorkspaceId) setWorkspaceId(activeWorkspaceId());
  }, [providedWorkspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

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
    try {
      const created = await adapter.createTransaction(workspaceId, {
        kind: transactionType,
        amount: { currency: "BRL", minor: amount },
        occurredOn: today(),
        state: planned ? "planned" : "posted",
        description,
        cardId: transactionCardId || null,
      });
      setTransactions((current) => [created, ...current]);
      setAmount("0");
      setDescription("");
      setTransactionCardId("");
      setPlanned(false);
      setNotice(planned ? "Compromisso salvo." : "Lançamento salvo.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o lançamento.");
    } finally {
      setSaving(false);
    }
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

  async function closeStatement(statement: Statement) {
    if (busyStatementId) return;
    setBusyStatementId(statement.id);
    setError(null);
    try {
      const closed = await adapter.closeStatement(workspaceId, statement);
      setStatements((current) => current.map((value) => (value.id === closed.id ? closed : value)));
      setNotice("Fatura fechada. Compras novas entram no próximo ciclo.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível fechar a fatura.");
    } finally {
      setBusyStatementId(null);
    }
  }

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
            Você pode continuar registrando ou revisar a linha do tempo abaixo.
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
              Saldo registrado
            </CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {formatMoneyMinor(walletTotal.toString())}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-primary-foreground/80">
            Somente lançamentos realizados na carteira.
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
              <MoneyInput value={amount} onChange={setAmount} label="Valor" />
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
            <CardDescription>Entradas, saídas e compromissos do espaço.</CardDescription>
          </CardHeader>
          <CardContent>
            {status === "loading" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Carregando lançamentos…
              </p>
            ) : transactions.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Nenhum lançamento ainda. Comece pelo valor acima.
              </p>
            ) : (
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
                        {transaction.state === "planned" ? "Planejada" : "Realizada"}
                      </p>
                    </div>
                    <span
                      className={
                        transaction.kind === "income"
                          ? "font-semibold text-emerald-700"
                          : "font-semibold text-foreground"
                      }
                    >
                      {transaction.kind === "income" ? "+" : "−"}
                      {formatMoneyMinor(transaction.amount.minor)}
                    </span>
                  </li>
                ))}
              </ul>
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
                          {formatMoneyMinor(statement.openAmount.minor)}
                        </p>
                        <div className="mt-1 flex gap-2">
                          {statement.state === "open" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyStatementId !== null || !writeAccess}
                              onClick={() => void closeStatement(statement)}
                            >
                              Fechar
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
    </div>
  );
}

export default function FinancesPage() {
  return <FinanceDashboard />;
}
