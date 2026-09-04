import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  Clock3Icon,
  HistoryIcon,
  SendIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type Loan,
  type LoanPayment,
  loanCounterpartyAction,
  loanDirectionLabel,
  loanProgressPercent,
  loanStatusLabel,
} from "@/lib/loans";
import { formatMoneyMinor } from "@/lib/money";

function formatCivilDate(value: string | null, empty = "Sem vencimento definido"): string {
  if (!value) return empty;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
}

function dueLabel(loan: Loan, today: string): string {
  if (!loan.dueOn) return "Sem vencimento definido";
  if (loan.status === "settled") return `Vencimento: ${formatCivilDate(loan.dueOn)}`;
  return loan.dueOn < today
    ? `Vencido em ${formatCivilDate(loan.dueOn)}`
    : `Vence em ${formatCivilDate(loan.dueOn)}`;
}

function statusForLoan(loan: Loan, today: string): "success" | "warning" | "info" {
  if (loan.status === "settled") return "success";
  if (loan.dueOn !== null && loan.dueOn < today) return "warning";
  return "info";
}

function LoanHistory({
  loan,
  payments,
  currency,
}: {
  loan: Loan;
  payments: LoanPayment[];
  currency: string;
}) {
  const hasAggregateOnly = payments.length === 0 && BigInt(loan.paid.minor) > BigInt(0);
  return (
    <section aria-labelledby={`${loan.id}-history-title`} className="border-t pt-4">
      <div className="flex items-center gap-2">
        <HistoryIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h3 id={`${loan.id}-history-title`} className="text-sm font-semibold">
          Histórico
        </h3>
      </div>
      <ol className="mt-3 flex flex-col gap-3 border-l pl-4 text-sm">
        <li className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[1.3rem] top-1 size-2 rounded-full bg-primary"
          />
          <p className="font-medium">Contrato registrado</p>
          <p className="text-muted-foreground">{formatCivilDate(loan.occurredOn)}</p>
        </li>
        {payments.map((payment) => (
          <li key={payment.id} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[1.3rem] top-1 size-2 rounded-full bg-emerald-600"
            />
            <p className="font-medium">
              Pagamento de {formatMoneyMinor(payment.amount.minor, currency)}
            </p>
            <p className="text-muted-foreground">{formatCivilDate(payment.occurredOn)}</p>
          </li>
        ))}
        {hasAggregateOnly ? (
          <li className="relative text-muted-foreground">
            <span
              aria-hidden="true"
              className="absolute -left-[1.3rem] top-1 size-2 rounded-full bg-muted-foreground"
            />
            <p>Pagamentos anteriores: {formatMoneyMinor(loan.paid.minor, currency)}</p>
            <p className="text-xs">O detalhamento ainda não foi carregado para este contrato.</p>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

export function LoanCard({
  loan,
  currency,
  today,
  payments,
  writable,
  onPay,
}: {
  loan: Loan;
  currency: string;
  today: string;
  payments: LoanPayment[];
  writable: boolean;
  onPay: (loan: Loan) => void;
}) {
  const progress = loanProgressPercent(loan);
  const isOpen = loan.status === "open";
  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">{loan.counterparty}</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{loanDirectionLabel(loan.direction)}</span>
              <span aria-hidden="true">·</span>
              <span>{dueLabel(loan, today)}</span>
            </CardDescription>
          </div>
          <StatusBadge status={statusForLoan(loan, today)}>
            {loanStatusLabel(loan.status)}
          </StatusBadge>
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              {loanCounterpartyAction(loan.direction)}
            </p>
            <p className="text-2xl font-semibold tracking-tight">
              {formatMoneyMinor(loan.remaining.minor, currency)}
            </p>
          </div>
          <p className="text-right text-sm text-muted-foreground">
            de {formatMoneyMinor(loan.principal.minor, currency)}
          </p>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Principal pago</span>
            <span>{progress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`Principal pago do empréstimo com ${loan.counterparty}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-2">
            <CalendarDaysIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div>
              <p className="font-medium">Cronograma</p>
              <p className="text-muted-foreground">{dueLabel(loan, today)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Clock3Icon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div>
              <p className="font-medium">Previsão de quitação</p>
              <p className="text-muted-foreground">
                {loan.status === "settled"
                  ? "Contrato quitado"
                  : loan.dueOn
                    ? `Se pago integralmente, até ${formatCivilDate(loan.dueOn)}`
                    : "Defina um vencimento para acompanhar a previsão"}
              </p>
            </div>
          </div>
        </div>
        {isOpen && writable ? (
          <Button type="button" className="min-h-11 w-full sm:w-fit" onClick={() => onPay(loan)}>
            <SendIcon data-icon="inline-start" aria-hidden="true" />
            Registrar pagamento
          </Button>
        ) : isOpen ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            Você tem acesso somente para leitura neste espaço.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2Icon aria-hidden="true" className="size-4" />
            Nenhum pagamento pendente.
          </p>
        )}
        <LoanHistory loan={loan} payments={payments} currency={currency} />
      </CardContent>
    </Card>
  );
}
