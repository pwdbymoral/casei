"use client";

import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  CheckIcon,
  CircleAlertIcon,
  HistoryIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  TargetIcon,
  WalletCardsIcon,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { AsyncState, MoneyInput, StatusBadge } from "@/components/primitives";
import { useAuthenticatedWorkspace } from "@/components/shell/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  canWriteGoals,
  type Goal,
  type GoalMovement,
  type GoalsAdapter,
  GoalsAdapterError,
  goalProgressPercent,
  goalsAdapterForEnvironment,
} from "@/lib/goals";
import { formatMoneyMinor } from "@/lib/money";

type GoalAction = "allocate" | "release" | "spend";
type PageStatus = "loading" | "success" | "empty" | "error" | "permission" | "offline";

function goalStatusLabel(status: Goal["status"]): string {
  if (status === "completed") return "Concluída";
  if (status === "paused") return "Pausada";
  if (status === "canceled") return "Cancelada";
  return "Ativa";
}

function priorityLabel(priority: Goal["priority"]): string {
  if (priority === "high") return "Prioridade alta";
  if (priority === "low") return "Prioridade baixa";
  return "Prioridade normal";
}

function actionLabel(action: GoalAction): string {
  if (action === "allocate") return "Reservar";
  if (action === "release") return "Retirar reserva";
  return "Usar reserva";
}

function movementLabel(kind: GoalMovement["kind"]): string {
  if (kind === "allocate") return "Reserva adicionada";
  if (kind === "release") return "Reserva retirada";
  return "Gasto da meta";
}

function deadlineLabel(deadline: string | null): string {
  if (!deadline) return "Sem prazo definido";
  const date = new Date(`${deadline}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? `Prazo ${deadline}`
    : `Prazo em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date)}`;
}

function errorStatus(error: unknown): PageStatus {
  if (error instanceof GoalsAdapterError && error.status === 403) return "permission";
  if (error instanceof GoalsAdapterError && error.status === undefined) return "offline";
  return "error";
}

function GoalCard({
  goal,
  currency,
  writable,
  busy,
  onAction,
  onHistory,
}: {
  goal: Goal;
  currency: string;
  writable: boolean;
  busy: boolean;
  onAction: (goal: Goal, action: GoalAction) => void;
  onHistory: (goal: Goal) => void;
}) {
  const progress = goalProgressPercent(goal);
  const uncovered = BigInt(goal.uncovered.minor) > BigInt(0);
  const disabled = busy || goal.status === "canceled" || goal.status === "paused";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">{goal.name}</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{deadlineLabel(goal.deadline)}</span>
              <span aria-hidden="true">·</span>
              <span>{priorityLabel(goal.priority)}</span>
            </CardDescription>
          </div>
          <StatusBadge
            status={goal.status === "completed" ? "success" : uncovered ? "warning" : "info"}
          >
            {goalStatusLabel(goal.status)}
          </StatusBadge>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Reservado</p>
            <p className="text-2xl font-semibold tracking-tight">
              {formatMoneyMinor(goal.reserved.minor, currency)}
            </p>
          </div>
          <p className="text-right text-sm text-muted-foreground">
            de {formatMoneyMinor(goal.target.minor, currency)}
          </p>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Progresso</span>
            <span>{progress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`Progresso da meta ${goal.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {uncovered ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Reserva sem cobertura</AlertTitle>
            <AlertDescription>
              {formatMoneyMinor(goal.uncovered.minor, currency)} da reserva excedem o saldo
              disponível.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!writable || disabled}
            onClick={() => onAction(goal, "allocate")}
          >
            <PlusIcon aria-hidden="true" /> Reservar
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!writable || busy || BigInt(goal.reserved.minor) <= BigInt(0)}
            onClick={() => onAction(goal, "release")}
          >
            <MinusIcon aria-hidden="true" /> Retirar
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!writable || disabled || BigInt(goal.reserved.minor) <= BigInt(0)}
            onClick={() => onAction(goal, "spend")}
          >
            <WalletCardsIcon aria-hidden="true" /> Usar
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 justify-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          disabled={busy}
          onClick={() => onHistory(goal)}
        >
          <HistoryIcon aria-hidden="true" /> Ver histórico
        </Button>
      </CardContent>
    </Card>
  );
}

export default function GoalsPage() {
  const { workspaceId, role, fixtureMode, currency } = useAuthenticatedWorkspace();
  const writable = canWriteGoals(role);
  const [adapter] = useState<GoalsAdapter>(() =>
    goalsAdapterForEnvironment({ fixtures: fixtureMode }),
  );
  const [goals, setGoals] = useState<Goal[]>([]);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<{ goal: Goal; kind: GoalAction } | null>(null);
  const [historyGoal, setHistoryGoal] = useState<Goal | null>(null);
  const [history, setHistory] = useState<GoalMovement[]>([]);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [targetMinor, setTargetMinor] = useState("0");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<Goal["priority"]>("normal");
  const [amountMinor, setAmountMinor] = useState("0");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const page = await adapter.listGoals(workspaceId);
      setGoals(page.items);
      setStatus(page.items.length > 0 ? "success" : "empty");
    } catch (cause) {
      setStatus(errorStatus(cause));
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar suas metas.");
    }
  }, [adapter, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      goals.reduce(
        (result, goal) => {
          result.reserved += BigInt(goal.reserved.minor);
          result.uncovered += BigInt(goal.uncovered.minor);
          return result;
        },
        { reserved: BigInt(0), uncovered: BigInt(0) },
      ),
    [goals],
  );

  function resetCreateForm() {
    setName("");
    setTargetMinor("0");
    setDeadline("");
    setPriority("normal");
    setFormError(null);
  }

  async function createGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = BigInt(targetMinor || "0");
    if (!name.trim()) {
      setFormError("Dê um nome para a meta.");
      return;
    }
    if (target <= BigInt(0)) {
      setFormError("Informe um valor maior que zero.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const goal = await adapter.createGoal(workspaceId, {
        name,
        target: { currency, minor: target.toString() },
        deadline: deadline || null,
        priority,
      });
      setGoals((current) => [goal, ...current]);
      setStatus("success");
      setCreateOpen(false);
      resetCreateForm();
      setNotice("Meta criada. Agora você pode reservar um valor para ela.");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Não foi possível criar a meta.");
    } finally {
      setBusy(false);
    }
  }

  function openAction(goal: Goal, kind: GoalAction) {
    setAction({ goal, kind });
    setAmountMinor("0");
    setNote("");
    setFormError(null);
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const amount = BigInt(amountMinor || "0");
    if (amount <= BigInt(0)) {
      setFormError("Informe um valor maior que zero.");
      return;
    }
    if (action.kind !== "allocate" && amount > BigInt(action.goal.reserved.minor)) {
      setFormError("O valor não pode ser maior que a reserva atual.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const input = { amount: { currency, minor: amount.toString() }, note: note || null };
      const result =
        action.kind === "allocate"
          ? await adapter.allocate(workspaceId, action.goal, { ...input, allowUncovered: false })
          : action.kind === "release"
            ? await adapter.release(workspaceId, action.goal, input)
            : await adapter.spend(workspaceId, action.goal, {
                ...input,
                description: note || "Gasto da meta",
              });
      setGoals((current) =>
        current.map((goal) => (goal.id === result.goal.id ? result.goal : goal)),
      );
      setAction(null);
      setNotice(
        action.kind === "allocate"
          ? "Reserva adicionada."
          : action.kind === "release"
            ? "Reserva retirada."
            : "Gasto registrado e reserva liberada.",
      );
    } catch (cause) {
      if (cause instanceof GoalsAdapterError && cause.status === 412) {
        await load();
        setFormError("A meta mudou enquanto você revisava. Atualizamos os dados; tente novamente.");
      } else {
        setFormError(cause instanceof Error ? cause.message : "Não foi possível atualizar a meta.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(goal: Goal) {
    setHistoryGoal(goal);
    setHistoryStatus("loading");
    try {
      const page = await adapter.listMovements(workspaceId, goal.id);
      setHistory(page.items);
      setHistoryStatus("idle");
    } catch {
      setHistory([]);
      setHistoryStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Reservas virtuais</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Metas</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Separe o que já é importante sem criar outra carteira. O saldo total continua no mesmo
            lugar.
          </p>
        </div>
        {writable ? (
          <Button type="button" className="min-h-11" onClick={() => setCreateOpen(true)}>
            <TargetIcon aria-hidden="true" /> Criar meta
          </Button>
        ) : null}
      </header>

      {notice ? (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertTitle>Pronto</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {status === "success" || status === "empty" ? (
        <>
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Resumo das metas">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Metas ativas</CardDescription>
                <CardTitle className="text-2xl">
                  {goals.filter((goal) => goal.status === "active").length}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total reservado</CardDescription>
                <CardTitle className="text-2xl">
                  {formatMoneyMinor(totals.reserved.toString(), currency)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Sem cobertura</CardDescription>
                <CardTitle className="text-2xl">
                  {formatMoneyMinor(totals.uncovered.toString(), currency)}
                </CardTitle>
              </CardHeader>
            </Card>
          </section>
          {status === "empty" ? (
            <Card>
              <CardHeader>
                <TargetIcon aria-hidden="true" className="mb-2" />
                <CardTitle>Comece sua primeira meta</CardTitle>
                <CardDescription>
                  Um objetivo pequeno já ajuda o Casei a mostrar o que merece espaço no orçamento.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {writable ? (
                  <Button type="button" onClick={() => setCreateOpen(true)}>
                    <PlusIcon aria-hidden="true" /> Criar minha primeira meta
                  </Button>
                ) : (
                  <StatusBadge status="neutral">Somente leitura</StatusBadge>
                )}
              </CardContent>
            </Card>
          ) : (
            <section className="grid gap-4 lg:grid-cols-2" aria-label="Metas cadastradas">
              {goals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  currency={currency}
                  writable={writable}
                  busy={busy}
                  onAction={openAction}
                  onHistory={openHistory}
                />
              ))}
            </section>
          )}
        </>
      ) : (
        <AsyncState
          status={status}
          title={
            status === "loading"
              ? "Carregando metas"
              : status === "permission"
                ? "Metas indisponíveis"
                : "Não foi possível carregar suas metas"
          }
          description={
            status === "offline"
              ? "Verifique sua conexão e tente novamente. Metas exigem conexão para não perder uma reserva."
              : (error ?? "Tente novamente em alguns instantes.")
          }
          action={
            status === "loading"
              ? undefined
              : { label: "Tentar novamente", onClick: () => void load() }
          }
        />
      )}

      <Alert>
        <CalendarDaysIcon aria-hidden="true" />
        <AlertTitle>Ritmo sem automação</AlertTitle>
        <AlertDescription>
          A contribuição sugerida e as simulações entram na próxima camada de planejamento. Reservar
          aqui nunca cria uma transação automaticamente.
        </AlertDescription>
      </Alert>

      <Link
        href="/app"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" /> Voltar para Hoje
      </Link>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Criar meta</DialogTitle>
            <DialogDescription>
              Informe só o essencial. Você pode enriquecer o objetivo depois.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={createGoal}>
            <Field>
              <FieldLabel htmlFor="goal-name">Nome da meta</FieldLabel>
              <Input
                id="goal-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ex.: viagem, reserva ou curso"
                autoFocus
              />
              <FieldDescription>Um nome curto ajuda a reconhecer a meta.</FieldDescription>
            </Field>
            <MoneyInput
              value={targetMinor}
              onChange={setTargetMinor}
              currency={currency}
              label="Valor-alvo"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="goal-deadline">Prazo (opcional)</FieldLabel>
                <Input
                  id="goal-deadline"
                  type="date"
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="goal-priority">Prioridade</FieldLabel>
                <select
                  id="goal-priority"
                  className="flex min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as Goal["priority"])}
                >
                  <option value="high">Alta</option>
                  <option value="normal">Normal</option>
                  <option value="low">Baixa</option>
                </select>
              </Field>
            </div>
            {formError ? <FieldError>{formError}</FieldError> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={busy}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckIcon aria-hidden="true" />
                )}
                {busy ? "Salvando…" : "Criar meta"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(action)} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{action ? actionLabel(action.kind) : "Atualizar meta"}</DialogTitle>
            <DialogDescription>
              {action?.kind === "allocate"
                ? "A reserva é virtual e não altera o saldo total da carteira."
                : action?.kind === "release"
                  ? "Retire um valor já reservado e devolva-o à parcela livre da carteira."
                  : "Registre um gasto real. O Casei libera a reserva e cria a despesa de uma vez."}
            </DialogDescription>
          </DialogHeader>
          {action ? (
            <form className="grid gap-4" onSubmit={submitAction}>
              <MoneyInput
                value={amountMinor}
                onChange={setAmountMinor}
                currency={currency}
                label="Valor"
                autoFocus
              />
              <Field>
                <FieldLabel htmlFor="goal-action-note">Observação</FieldLabel>
                <Input
                  id="goal-action-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={action.kind === "spend" ? "Ex.: compra do material" : "Opcional"}
                />
              </Field>
              <p className="text-sm text-muted-foreground">
                Reserva atual: {formatMoneyMinor(action.goal.reserved.minor, currency)}
              </p>
              {formError ? <FieldError>{formError}</FieldError> : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAction(null)}
                  disabled={busy}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckIcon aria-hidden="true" />
                  )}
                  {busy ? "Salvando…" : actionLabel(action.kind)}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(historyGoal)} onOpenChange={(open) => !open && setHistoryGoal(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Histórico da meta</DialogTitle>
            <DialogDescription>{historyGoal?.name}</DialogDescription>
          </DialogHeader>
          {historyStatus === "loading" ? (
            <div
              className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> Carregando histórico…
            </div>
          ) : historyStatus === "error" ? (
            <AsyncState
              status="error"
              title="Histórico indisponível"
              description="Tente novamente ao abrir a meta."
            />
          ) : history.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nenhuma movimentação ainda.
            </div>
          ) : (
            <ol className="grid gap-3" aria-label="Movimentações da meta">
              {history.map((movement) => (
                <li
                  key={movement.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{movementLabel(movement.kind)}</p>
                    <p className="text-xs text-muted-foreground">
                      {movement.occurredOn}
                      {movement.note ? ` · ${movement.note}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium">
                    {formatMoneyMinor(movement.amount.minor, currency)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
