"use client";

import {
  ArrowRightIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  ShoppingBasketIcon,
  TargetIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AsyncState, StatusBadge } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  civilDateInTimeZone,
  type FinanceAdapter,
  FinanceAdapterError,
  financeAdapterForEnvironment,
  listAllTransactions,
} from "@/lib/finance";
import { type Goal, type GoalsAdapter, goalsAdapterForEnvironment } from "@/lib/goals";
import {
  confidenceLabel,
  type FinancialReadModel,
  type InsightAdapter,
  InsightAdapterError,
  insightAdapterForEnvironment,
  insightReasonLabel,
  type SafeToSpendView,
} from "@/lib/insights";
import { formatMoneyMinor } from "@/lib/money";
import { type StockAdapter, type StockShoppingItem, stockAdapterForEnvironment } from "@/lib/stock";
import {
  buildTodayCommitments,
  goalsRequiringAttention,
  type TodayCommitment,
} from "@/lib/today-dashboard";
import { cn } from "@/lib/utils";

const quickActions = [
  {
    href: "/app/add?type=expense",
    label: "Despesa",
    description: "Registre em poucos segundos.",
    symbol: "−",
  },
  {
    href: "/app/add?type=income",
    label: "Receita",
    description: "Adicione o que entrou.",
    symbol: "+",
  },
  {
    href: "/app/add?type=stock",
    label: "Produto",
    description: "Atualize o que há em casa.",
    symbol: "＋",
  },
] as const;

type DashboardStatus = "loading" | "success" | "error" | "offline" | "permission";

type DashboardData = {
  financial: FinancialReadModel;
  safeToSpend: SafeToSpendView;
  commitments: TodayCommitment[];
  goals: Goal[];
  shoppingItems: StockShoppingItem[];
};

function errorStatus(error: unknown): DashboardStatus {
  if (
    (error instanceof InsightAdapterError || error instanceof FinanceAdapterError) &&
    error.status === 403
  )
    return "permission";
  if (
    (error instanceof InsightAdapterError || error instanceof FinanceAdapterError) &&
    error.status === undefined
  )
    return "offline";
  return "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Tente novamente. Seus dados permanecem no servidor.";
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  })
    .format(date)
    .replace(" de ", " ");
}

function commitmentLabel(commitment: TodayCommitment): string {
  return commitment.bucket === "overdue"
    ? `Vencida em ${dateLabel(commitment.dueOn)}`
    : `Vence em ${dateLabel(commitment.dueOn)}`;
}

function SensitiveMoney({
  minor,
  currency,
  hidden,
  className,
}: {
  minor: string;
  currency: string;
  hidden: boolean;
  className?: string;
}) {
  const value = formatMoneyMinor(minor, currency);
  if (!hidden) return <span className={className}>{value}</span>;
  return (
    <>
      <span aria-hidden="true" className={className}>
        ••••••
      </span>
      <span className="sr-only">{value}</span>
    </>
  );
}

function VisibilityButton({ hidden, onChange }: { hidden: boolean; onChange: () => void }) {
  const Icon = hidden ? EyeIcon : EyeOffIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11 gap-2 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
      aria-pressed={hidden}
      aria-label={hidden ? "Mostrar valores" : "Ocultar valores"}
      onClick={onChange}
    >
      <Icon aria-hidden="true" />
      <span className="hidden sm:inline">{hidden ? "Mostrar valores" : "Ocultar valores"}</span>
    </Button>
  );
}

function CommitmentCard({ commitment, hidden }: { commitment: TodayCommitment; hidden: boolean }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <Link
          href={commitment.href}
          className="font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {commitment.title}
        </Link>
        <p
          className={cn(
            "text-sm",
            commitment.bucket === "overdue" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {commitmentLabel(commitment)}
        </p>
      </div>
      <SensitiveMoney
        minor={commitment.amountMinor}
        currency={commitment.currency}
        hidden={hidden}
        className="font-medium"
      />
    </li>
  );
}

function DashboardContent({
  data,
  hidden,
  onToggleHidden,
}: {
  data: DashboardData;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const { financial, safeToSpend, commitments, goals, shoppingItems } = data;
  const attentionGoals = goalsRequiringAttention(goals, financial.asOf);
  const overdueCommitments = commitments.filter((item) => item.bucket === "overdue");

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Bom dia</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Um passo de cada vez.
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Resumo de {dateLabel(financial.asOf)}.
          </p>
        </div>
        <StatusBadge status="success">Dados atualizados agora</StatusBadge>
      </section>

      <section className="grid gap-4 md:grid-cols-[1.25fr_1fr]" aria-label="Resumo financeiro">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardDescription className="text-primary-foreground/70">
                Saldo na carteira
              </CardDescription>
              <VisibilityButton hidden={hidden} onChange={onToggleHidden} />
            </div>
            <CardTitle className="text-3xl font-semibold tracking-tight">
              <SensitiveMoney
                minor={financial.balance.minor}
                currency={financial.currency}
                hidden={hidden}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-primary-foreground/80">
            <span>
              {financial.confidence.level === "low"
                ? "Saldo ainda precisa de conferência."
                : "Saldo reconstruído dos lançamentos publicados."}
            </span>
            <Link
              href="/app/finances"
              className="inline-flex min-h-11 items-center gap-1 font-medium text-primary-foreground underline-offset-4 hover:underline"
            >
              Ver carteira <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
        <Card id="safe-to-spend">
          <CardHeader>
            <CardDescription>Valor seguro para gastar</CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">
              {safeToSpend.available && safeToSpend.safe ? (
                <SensitiveMoney
                  minor={safeToSpend.safe.minor}
                  currency={safeToSpend.currency}
                  hidden={hidden}
                />
              ) : (
                "Indisponível"
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <span>
              Próximos {safeToSpend.horizonDays} dias ·{" "}
              {confidenceLabel(safeToSpend.confidence.level)}
            </span>
            <Link
              href="/app/finances#safe-to-spend"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {safeToSpend.available ? "Entender o cálculo" : "Revisar dados necessários"}
            </Link>
          </CardContent>
        </Card>
      </section>

      {safeToSpend.confidence.level !== "high" ? (
        <Alert>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Suas projeções ainda estão aprendendo.</AlertTitle>
          <AlertDescription>
            {safeToSpend.confidence.reasons.map(insightReasonLabel).join(" · ")}.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="quick-actions-title">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <h2 id="quick-actions-title" className="text-lg font-semibold">
              Adicionar rapidamente
            </h2>
            <p className="text-sm text-muted-foreground">
              Só o essencial agora; detalhes podem esperar.
            </p>
          </div>
          <Link href="/app/add" className="text-sm font-medium underline-offset-4 hover:underline">
            Ver tudo
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex min-h-24 items-center gap-3 rounded-xl border bg-background p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg font-semibold group-hover:bg-primary group-hover:text-primary-foreground">
                {action.symbol}
              </span>
              <span className="min-w-0">
                <strong className="block font-medium">{action.label}</strong>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {action.description}
                </span>
              </span>
              <ArrowRightIcon
                className="ml-auto shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-[1.2fr_1fr]" aria-label="Ações prioritárias">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CalendarClockIcon aria-hidden="true" className="mb-2" />
                <CardTitle>Próximos compromissos</CardTitle>
                <CardDescription>Vencidos e previstos nos próximos sete dias.</CardDescription>
              </div>
              <StatusBadge status={overdueCommitments.length > 0 ? "warning" : "info"}>
                {String(commitments.length)}
              </StatusBadge>
            </div>
          </CardHeader>
          <CardContent>
            {commitments.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Nenhum compromisso exige ação nesta semana.
              </p>
            ) : (
              <ul aria-label="Compromissos próximos">
                {commitments.slice(0, 5).map((commitment) => (
                  <CommitmentCard key={commitment.id} commitment={commitment} hidden={hidden} />
                ))}
              </ul>
            )}
            <Link
              href="/app/finances"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4 w-full")}
            >
              Revisar planejamento
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <TargetIcon aria-hidden="true" className="mb-2" />
                <CardTitle>Metas que pedem atenção</CardTitle>
                <CardDescription>Reservas sem cobertura ou prazos próximos.</CardDescription>
              </div>
              <StatusBadge status={attentionGoals.length > 0 ? "warning" : "info"}>
                {String(attentionGoals.length)}
              </StatusBadge>
            </div>
          </CardHeader>
          <CardContent>
            {attentionGoals.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Nenhuma meta precisa de ação agora.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {attentionGoals.slice(0, 3).map((goal) => (
                  <li
                    key={goal.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{goal.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {goal.uncovered.minor !== "0"
                          ? "Reserva sem cobertura"
                          : `Prazo ${dateLabel(goal.deadline ?? "")}`}
                      </p>
                    </div>
                    <SensitiveMoney
                      minor={goal.reserved.minor}
                      currency={goal.reserved.currency}
                      hidden={hidden}
                      className="shrink-0 font-medium"
                    />
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/app/goals"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4 w-full")}
            >
              Ver metas
            </Link>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <ShoppingBasketIcon aria-hidden="true" className="mb-2" />
              <CardTitle>O que falta em casa</CardTitle>
              <CardDescription>Itens da lista para lembrar no mercado.</CardDescription>
            </div>
            <StatusBadge status={shoppingItems.length > 0 ? "warning" : "success"}>
              {String(shoppingItems.length)}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardContent>
          {shoppingItems.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Nenhum item marcado como faltando.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shoppingItems.slice(0, 6).map((item) => (
                <li key={item.id} className="rounded-lg border p-3">
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {item.quantity
                      ? `${item.quantity} ${item.unitLabel ?? item.unit}`
                      : "Quantidade não definida"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/app/home"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "mt-4 w-full sm:w-auto",
            )}
          >
            Abrir estoque
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default function TodayPage() {
  const { workspaceId, fixtureMode, timeZone } = useAuthenticatedWorkspace();
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [hidden, setHidden] = useState(false);
  const insightAdapter = useMemo<InsightAdapter>(
    () => insightAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const financeAdapter = useMemo<FinanceAdapter>(
    () => financeAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const goalsAdapter = useMemo<GoalsAdapter>(
    () => goalsAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );
  const stockAdapter = useMemo<StockAdapter>(
    () => stockAdapterForEnvironment({ fixtures: fixtureMode }),
    [fixtureMode],
  );

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const asOf = civilDateInTimeZone(new Date(), timeZone);
      const [financial, safeToSpend, transactions, statements, goalPage, shoppingItems] =
        await Promise.all([
          insightAdapter.getFinancial(workspaceId, { asOf }),
          insightAdapter.getSafeToSpend(workspaceId, { asOf, horizonDays: 30 }),
          listAllTransactions(financeAdapter, workspaceId),
          financeAdapter.listStatements(workspaceId),
          goalsAdapter.listGoals(workspaceId, { limit: 100 }),
          stockAdapter.listShoppingItems(workspaceId),
        ]);
      setData({
        financial,
        safeToSpend,
        commitments: buildTodayCommitments({
          transactions,
          statements,
          asOf: financial.asOf,
          currency: financial.currency,
        }),
        goals: goalPage.items,
        shoppingItems,
      });
      setStatus("success");
    } catch (cause) {
      setData(null);
      setError(errorMessage(cause));
      setStatus(errorStatus(cause));
    }
  }, [financeAdapter, goalsAdapter, insightAdapter, stockAdapter, timeZone, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AsyncState
      status={status}
      title={status === "permission" ? "Este espaço não está disponível" : undefined}
      description={
        status === "permission"
          ? "Sua permissão mudou. Escolha outro espaço para continuar."
          : (error ?? undefined)
      }
      action={
        status === "error" || status === "offline"
          ? { label: "Tentar novamente", onClick: () => void load() }
          : undefined
      }
    >
      {data ? (
        <DashboardContent
          data={data}
          hidden={hidden}
          onToggleHidden={() => setHidden((current) => !current)}
        />
      ) : null}
    </AsyncState>
  );
}
