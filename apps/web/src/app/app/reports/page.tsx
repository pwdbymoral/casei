"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FlaskConicalIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type Category,
  canWriteFinance,
  civilDateInTimeZone,
  financeAdapterForEnvironment,
  listAllTransactions,
} from "@/lib/finance";
import { formatMoneyMinor } from "@/lib/money";
import {
  applySimulationChanges,
  type FinancialReport,
  type ReportFilters,
  reportAdapterForEnvironment,
  reportExportPath,
  reportFiltersFromSearchParams,
  reportFiltersToSearchParams,
  type SimulationChange,
  type SimulationEvent,
  simulationEventFromTransaction,
  simulationToPlannedTransaction,
} from "@/lib/reports";

type SurfaceStatus = "loading" | "success" | "error" | "permission";

function firstDayOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function amountLabel(minor: string, currency: string): string {
  return formatMoneyMinor(minor, currency);
}

function signedAmountLabel(minor: string, currency: string): string {
  const value = BigInt(minor);
  return `${value < BigInt(0) ? "−" : "+"}${formatMoneyMinor(
    (value < BigInt(0) ? -value : value).toString(),
    currency,
  )}`;
}

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function transactionEvents(
  transactions: Parameters<typeof simulationEventFromTransaction>[0][],
  categories: readonly Category[],
): SimulationEvent[] {
  const names = new Map(categories.map((category) => [category.id, category.name]));
  return transactions
    .map((transaction) =>
      simulationEventFromTransaction(
        transaction,
        names.get(transaction.categoryId ?? "") ?? "Sem categoria",
      ),
    )
    .filter((event): event is SimulationEvent => event !== null);
}

export default function ReportsPage() {
  const { workspaceId, role, fixtureMode, timeZone, currency } = useAuthenticatedWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const today = civilDateInTimeZone(new Date(), timeZone);
  const [filters, setFilters] = useState<ReportFilters>(() =>
    reportFiltersFromSearchParams(searchParams, {
      from: firstDayOfMonth(today),
      to: today,
    }),
  );
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [changes, setChanges] = useState<SimulationChange[]>([]);
  const [status, setStatus] = useState<SurfaceStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [simulationKind, setSimulationKind] = useState<"income" | "expense">("expense");
  const [simulationAmount, setSimulationAmount] = useState("");
  const [simulationDate, setSimulationDate] = useState(today);
  const [simulationCategoryId, setSimulationCategoryId] = useState("");
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const adapter = useMemo(
    () => reportAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const financeAdapter = useMemo(
    () => financeAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const writeAccess = canWriteFinance(role);
  const simulatedReport = useMemo(
    () => (report ? applySimulationChanges(report, events, changes) : null),
    [report, events, changes],
  );

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [nextReport, nextCategories, transactions] = await Promise.all([
        adapter.getReport(workspaceId, filters),
        financeAdapter.listCategories(workspaceId),
        listAllTransactions(financeAdapter, workspaceId, {
          from: filters.from,
          to: filters.to,
          kind: filters.kind === "all" ? undefined : filters.kind,
        }),
      ]);
      setReport(nextReport);
      setCategories(nextCategories);
      setEvents(
        transactionEvents(
          transactions.filter(
            (transaction) =>
              transaction.state === "posted" || transaction.state === "partially_settled",
          ),
          nextCategories,
        ),
      );
      setChanges([]);
      setStatus("success");
    } catch (cause) {
      setStatus(
        cause instanceof Error &&
          "status" in cause &&
          (cause.status === 401 || cause.status === 403)
          ? "permission"
          : "error",
      );
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os relatórios.");
    }
  }, [adapter, financeAdapter, filters, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateFilters(next: Partial<ReportFilters>) {
    const updated = { ...filters, ...next };
    if (updated.from > updated.to) return;
    setFilters(updated);
    const params = reportFiltersToSearchParams(updated);
    router.replace(`/app/reports?${params.toString()}`, { scroll: false });
  }

  function addSimulation() {
    setSimulationError(null);
    if (!/^\d+$/.test(simulationAmount) || BigInt(simulationAmount) <= BigInt(0)) {
      setSimulationError("Informe um valor maior que zero em centavos.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(simulationDate)) {
      setSimulationError("Informe uma data válida.");
      return;
    }
    const category = categories.find((item) => item.id === simulationCategoryId);
    const event: SimulationEvent = {
      id: `simulation-${crypto.randomUUID()}`,
      kind: simulationKind,
      amountMinor: simulationAmount,
      occurredOn: simulationDate,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? "Sem categoria",
    };
    setChanges((current) => [
      ...current,
      { id: `change-${crypto.randomUUID()}`, operation: "add", event },
    ]);
    setSimulationAmount("");
    setNotice("Evento adicionado somente à simulação. Nada foi salvo.");
  }

  async function applySimulation() {
    if (!writeAccess || changes.length === 0) return;
    setApplying(true);
    setSimulationError(null);
    try {
      for (const change of changes) {
        await financeAdapter.createTransaction(
          workspaceId,
          simulationToPlannedTransaction(change.event, currency),
          `report-simulation-${change.id}`,
        );
      }
      setChanges([]);
      setNotice("Planejamento aplicado. Os eventos agora aparecem como compromissos futuros.");
      await load();
    } catch (cause) {
      setSimulationError(
        cause instanceof Error ? cause.message : "Não foi possível aplicar o planejamento.",
      );
    } finally {
      setApplying(false);
    }
  }

  return (
    <main className="flex flex-col gap-6">
      <section>
        <p className="text-sm text-muted-foreground">Decisões com contexto</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Relatórios</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Consulte o mesmo recorte que pode ser exportado. Totais vêm dos lançamentos publicados;
          simulações ficam separadas até você decidir aplicar como planejamento.
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Filtros do relatório</CardTitle>
          <CardDescription>
            O período e a categoria permanecem na URL e acompanham a exportação.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="report-from">De</FieldLabel>
              <Input
                id="report-from"
                type="date"
                value={filters.from}
                onChange={(event) => updateFilters({ from: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="report-to">Até</FieldLabel>
              <Input
                id="report-to"
                type="date"
                value={filters.to}
                onChange={(event) => updateFilters({ to: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="report-kind">Tipo</FieldLabel>
              <select
                id="report-kind"
                className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={filters.kind}
                onChange={(event) =>
                  updateFilters({ kind: event.target.value as ReportFilters["kind"] })
                }
              >
                <option value="all">Receitas e despesas</option>
                <option value="income">Somente receitas</option>
                <option value="expense">Somente despesas</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="report-category">Categoria</FieldLabel>
              <select
                id="report-category"
                className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={filters.categoryId ?? ""}
                onChange={(event) => updateFilters({ categoryId: event.target.value || null })}
              >
                <option value="">Todas</option>
                {categories
                  .filter((category) => !category.archived)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </select>
            </Field>
          </FieldGroup>
          <FieldDescription className="mt-4">
            Use datas civis do espaço. O relatório não inclui compromissos planejados.
          </FieldDescription>
        </CardContent>
      </Card>

      {status === "loading" ? <AsyncState status="loading" title="Carregando relatório" /> : null}
      {status === "permission" ? (
        <AsyncState
          status="permission"
          title="Sem permissão para este relatório"
          description={error ?? undefined}
          action={{ label: "Tentar novamente", onClick: () => void load() }}
        />
      ) : null}
      {status === "error" ? (
        <AsyncState
          status="error"
          title="Não foi possível carregar o relatório"
          description={error ?? undefined}
          action={{ label: "Tentar novamente", onClick: () => void load() }}
        />
      ) : null}

      {status === "success" && simulatedReport ? (
        <>
          {notice ? (
            <Alert>
              <CheckCircle2Icon aria-hidden="true" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <section aria-label="Totais do relatório" className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardDescription>Receitas</CardDescription>
                <CardTitle>{amountLabel(simulatedReport.totals.income.minor, currency)}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Despesas</CardDescription>
                <CardTitle>{amountLabel(simulatedReport.totals.expense.minor, currency)}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Resultado</CardDescription>
                <CardTitle>
                  {signedAmountLabel(simulatedReport.totals.net.minor, currency)}
                </CardTitle>
              </CardHeader>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Visão mensal</CardTitle>
              <CardDescription>
                {simulatedReport.totals.transactionCount} lançamento(s) no recorte.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-left text-sm">
                  <caption className="sr-only">Receitas, despesas e resultado por mês</caption>
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Mês
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Receitas
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Despesas
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Resultado
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Lançamentos
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulatedReport.monthly.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                          Nenhum lançamento publicado neste período.
                        </td>
                      </tr>
                    ) : (
                      simulatedReport.monthly.map((item) => (
                        <tr key={item.month} className="border-b last:border-0">
                          <th scope="row" className="px-3 py-3 font-medium">
                            {monthLabel(item.month)}
                          </th>
                          <td className="px-3 py-3">{amountLabel(item.income.minor, currency)}</td>
                          <td className="px-3 py-3">{amountLabel(item.expense.minor, currency)}</td>
                          <td className="px-3 py-3">
                            {signedAmountLabel(item.net.minor, currency)}
                          </td>
                          <td className="px-3 py-3">{item.transactionCount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Por categoria</CardTitle>
              <CardDescription>
                A soma das categorias reconcilia com o total do recorte; “Sem categoria” fica
                explícita.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-left text-sm">
                  <caption className="sr-only">
                    Receitas, despesas e resultado por categoria
                  </caption>
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Categoria
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Receitas
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Despesas
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Resultado
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Lançamentos
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulatedReport.categories.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                          Nenhuma categoria movimentada neste período.
                        </td>
                      </tr>
                    ) : (
                      simulatedReport.categories.map((item) => (
                        <tr
                          key={item.categoryId ?? "uncategorized"}
                          className="border-b last:border-0"
                        >
                          <th scope="row" className="px-3 py-3 font-medium">
                            {item.categoryName}
                          </th>
                          <td className="px-3 py-3">{amountLabel(item.income.minor, currency)}</td>
                          <td className="px-3 py-3">{amountLabel(item.expense.minor, currency)}</td>
                          <td className="px-3 py-3">
                            {signedAmountLabel(item.net.minor, currency)}
                          </td>
                          <td className="px-3 py-3">{item.transactionCount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Alert>
            <CheckCircle2Icon aria-hidden="true" />
            <AlertTitle>Reconciliação disponível</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>
                {simulatedReport.reconciliation.transactionCount} lançamento(s) publicados · fonte:
                ledger.
              </span>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={reportExportPath(filters)}
              >
                Exportar este recorte
              </Link>
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <div className="flex items-start gap-3">
                <FlaskConicalIcon aria-hidden="true" />
                <div>
                  <CardTitle>Simular sem salvar</CardTitle>
                  <CardDescription>
                    Adicione um evento hipotético à prévia. Nada muda no Casei até aplicar como
                    planejamento.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor="simulation-kind">Tipo</FieldLabel>
                  <select
                    id="simulation-kind"
                    className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={simulationKind}
                    onChange={(event) =>
                      setSimulationKind(event.target.value as "income" | "expense")
                    }
                  >
                    <option value="expense">Gasto hipotético</option>
                    <option value="income">Entrada hipotética</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="simulation-amount">Valor (centavos)</FieldLabel>
                  <Input
                    id="simulation-amount"
                    inputMode="numeric"
                    value={simulationAmount}
                    onChange={(event) => setSimulationAmount(event.target.value.replace(/\D/g, ""))}
                    placeholder="Ex.: 15000"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="simulation-date">Data</FieldLabel>
                  <Input
                    id="simulation-date"
                    type="date"
                    value={simulationDate}
                    onChange={(event) => setSimulationDate(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="simulation-category">Categoria</FieldLabel>
                  <select
                    id="simulation-category"
                    className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={simulationCategoryId}
                    onChange={(event) => setSimulationCategoryId(event.target.value)}
                  >
                    <option value="">Sem categoria</option>
                    {categories
                      .filter((category) => !category.archived)
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </FieldGroup>
              {simulationError ? (
                <Alert variant="destructive">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertDescription>{simulationError}</AlertDescription>
                </Alert>
              ) : null}
              {changes.length > 0 ? (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">{changes.length} alteração(ões) temporária(s)</p>
                  <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
                    {changes.map((change) => (
                      <li key={change.id}>
                        {change.event.kind === "expense" ? "Gasto" : "Entrada"} de{" "}
                        {amountLabel(change.event.amountMinor, currency)} em{" "}
                        {change.event.occurredOn} · {change.event.categoryName}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-2 min-h-8"
                          onClick={() =>
                            setChanges((current) => current.filter((item) => item.id !== change.id))
                          }
                        >
                          Remover
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button type="button" variant="outline" onClick={addSimulation}>
                  Adicionar à simulação
                </Button>
                <Button
                  type="button"
                  disabled={!writeAccess || changes.length === 0 || applying}
                  onClick={() => void applySimulation()}
                >
                  {applying ? (
                    <LoaderCircleIcon
                      data-icon="inline-start"
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" />
                  )}{" "}
                  {applying ? "Aplicando…" : "Aplicar como planejamento"}
                </Button>
              </div>
              {!writeAccess ? (
                <p className="text-sm text-muted-foreground">
                  Seu papel pode consultar e simular, mas não pode criar planejamento.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </main>
  );
}
