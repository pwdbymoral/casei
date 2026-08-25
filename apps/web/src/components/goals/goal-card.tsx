import {
  CalendarDaysIcon,
  CircleAlertIcon,
  HistoryIcon,
  MinusIcon,
  PlusIcon,
  WalletCardsIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Goal, goalPace, goalProgressPercent } from "@/lib/goals";
import { formatMoneyMinor } from "@/lib/money";

export type GoalAction = "allocate" | "release" | "spend";

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

function deadlineLabel(deadline: string | null): string {
  if (!deadline) return "Sem prazo definido";
  const date = new Date(`${deadline}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? `Prazo ${deadline}`
    : `Prazo em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date)}`;
}

function paceLabel(goal: Goal, currency: string): string {
  const pace = goalPace(goal);
  if (pace.status === "complete") return "Meta atingida";
  if (pace.status === "no_deadline") return "Defina um prazo para ver o ritmo sugerido";
  if (pace.status === "overdue") return "Prazo vencido; revise o objetivo";
  if (pace.status === "on_track" && pace.monthlyMinor) {
    return `${formatMoneyMinor(pace.monthlyMinor, currency)} por mês · ${pace.periods} período(s)`;
  }
  return "Ritmo indisponível";
}

export function GoalCard({
  goal,
  currency,
  writable,
  busy,
  onAction,
  onHistory,
  onSimulation,
}: {
  goal: Goal;
  currency: string;
  writable: boolean;
  busy: boolean;
  onAction: (goal: Goal, action: GoalAction) => void;
  onHistory: (goal: Goal) => void;
  onSimulation: (goal: Goal) => void;
}) {
  const progress = goalProgressPercent(goal);
  const uncovered = BigInt(goal.uncovered.minor) > BigInt(0);
  const disabled = busy || goal.status === "canceled" || goal.status === "paused";
  const remaining = BigInt(goal.remaining.minor);

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
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <CalendarDaysIcon aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">Ritmo sugerido: </span>
            {paceLabel(goal, currency)}
          </span>
        </p>
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
            disabled={!writable || disabled || BigInt(goal.reserved.minor) <= BigInt(0)}
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
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 justify-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          disabled={busy || remaining <= BigInt(0)}
          onClick={() => onSimulation(goal)}
        >
          <CalendarDaysIcon aria-hidden="true" /> Simular contribuição
        </Button>
      </CardContent>
    </Card>
  );
}
