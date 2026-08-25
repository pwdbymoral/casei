"use client";

import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  CircleDollarSignIcon,
  Clock3Icon,
  HandCoinsIcon,
  HistoryIcon,
  PlusIcon,
  SendIcon,
  WalletCardsIcon,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { civilDateInTimeZone } from "@/lib/finance";
import {
  type Loan,
  type LoanPayment,
  type LoansAdapter,
  LoansAdapterError,
  listAllLoanPayments,
  loanCounterpartyAction,
  loanDirectionLabel,
  loanProgressPercent,
  loanStatusLabel,
  loansAdapterForEnvironment,
  upsertLoanPayment,
} from "@/lib/loans";
import { formatMoneyMinor } from "@/lib/money";

type PageStatus = "loading" | "success" | "empty" | "error" | "permission" | "offline";

function todayInTimeZone(timeZone: string): string {
  return civilDateInTimeZone(new Date(), timeZone);
}

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

function errorPageStatus(error: unknown): PageStatus {
  if (error instanceof LoansAdapterError && error.status === 403) return "permission";
  if (error instanceof LoansAdapterError && error.status === undefined) return "offline";
  return "error";
}

function totalRemaining(loans: Loan[], direction: Loan["direction"]): bigint {
  return loans.reduce(
    (total, loan) =>
      total +
      (loan.direction === direction && loan.status === "open"
        ? BigInt(loan.remaining.minor)
        : BigInt(0)),
    BigInt(0),
  );
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

function LoanCard({
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

export default function LoansPage() {
  const { workspaceId, role, fixtureMode, currency, timeZone } = useAuthenticatedWorkspace();
  const writable = role !== "viewer";
  const [adapter] = useState<LoansAdapter>(() =>
    loansAdapterForEnvironment({ fixtures: fixtureMode }),
  );
  const [loans, setLoans] = useState<Loan[]>([]);
  const [payments, setPayments] = useState<Record<string, LoanPayment[]>>({});
  const [status, setStatus] = useState<PageStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [payingLoan, setPayingLoan] = useState<Loan | null>(null);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState(false);
  const [counterparty, setCounterparty] = useState("");
  const [direction, setDirection] = useState<Loan["direction"]>("lent");
  const [principalMinor, setPrincipalMinor] = useState("0");
  const [occurredOn, setOccurredOn] = useState(() => todayInTimeZone(timeZone));
  const [dueOn, setDueOn] = useState("");
  const [paymentMinor, setPaymentMinor] = useState("0");
  const [paymentDate, setPaymentDate] = useState(() => todayInTimeZone(timeZone));
  const [formError, setFormError] = useState<string | null>(null);
  const createCommandKey = useRef<string | null>(null);
  const paymentCommandKey = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  const today = todayInTimeZone(timeZone);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setStatus("loading");
    setError(null);
    try {
      const page = await adapter.listLoans(workspaceId, { limit: 100 });
      if (generation !== requestGeneration.current) return;
      setLoans(page.items);
      const entries = await Promise.all(
        page.items.map(
          async (loan) =>
            [loan.id, await listAllLoanPayments(adapter, workspaceId, loan.id)] as const,
        ),
      );
      if (generation !== requestGeneration.current) return;
      setPayments(Object.fromEntries(entries));
      setStatus(page.items.length ? "success" : "empty");
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setStatus(errorPageStatus(cause));
      setError(
        cause instanceof Error ? cause.message : "Não foi possível carregar os empréstimos.",
      );
    }
  }, [adapter, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setOccurredOn(todayInTimeZone(timeZone));
    setPaymentDate(todayInTimeZone(timeZone));
  }, [timeZone]);

  const toReceive = useMemo(() => totalRemaining(loans, "lent"), [loans]);
  const toPay = useMemo(() => totalRemaining(loans, "borrowed"), [loans]);
  const openCount = useMemo(() => loans.filter((loan) => loan.status === "open").length, [loans]);

  function openCreate() {
    setFormError(null);
    setNotice(null);
    setCounterparty("");
    setDirection("lent");
    setPrincipalMinor("0");
    setOccurredOn(today);
    setDueOn("");
    createCommandKey.current = null;
    setCreateOpen(true);
  }

  function openPayment(loan: Loan) {
    setFormError(null);
    setNotice(null);
    setPaymentMinor(loan.remaining.minor);
    setPaymentDate(today >= loan.occurredOn ? today : loan.occurredOn);
    paymentCommandKey.current = null;
    setPayingLoan(loan);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (!counterparty.trim()) {
      setFormError("Informe com quem foi o empréstimo.");
      return;
    }
    if (BigInt(principalMinor) <= BigInt(0)) {
      setFormError("Informe um valor maior que zero.");
      return;
    }
    if (dueOn && dueOn < occurredOn) {
      setFormError("O vencimento não pode ser anterior à data do empréstimo.");
      return;
    }
    setCreating(true);
    setFormError(null);
    createCommandKey.current ??= `loan-create-${globalThis.crypto.randomUUID()}`;
    try {
      const created = await adapter.createLoan(
        workspaceId,
        {
          direction,
          counterparty: counterparty.trim(),
          principal: { currency, minor: principalMinor },
          occurredOn,
          dueOn: dueOn || null,
        },
        createCommandKey.current,
      );
      setLoans((current) => [...current, created]);
      setPayments((current) => ({ ...current, [created.id]: [] }));
      setCreateOpen(false);
      setNotice("Empréstimo registrado. O movimento já foi refletido na carteira.");
      createCommandKey.current = null;
      setStatus("success");
    } catch (cause) {
      if (cause instanceof LoansAdapterError && cause.status === 412) {
        await load();
      }
      setFormError(
        cause instanceof Error ? cause.message : "Não foi possível registrar o empréstimo.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payingLoan || paying) return;
    const amount = BigInt(paymentMinor);
    if (amount <= BigInt(0)) {
      setFormError("Informe um valor maior que zero.");
      return;
    }
    if (amount > BigInt(payingLoan.remaining.minor)) {
      setFormError("O pagamento não pode exceder o saldo restante.");
      return;
    }
    if (paymentDate < payingLoan.occurredOn) {
      setFormError("A data do pagamento não pode ser anterior à data do empréstimo.");
      return;
    }
    setPaying(true);
    setFormError(null);
    paymentCommandKey.current ??= `loan-payment-${globalThis.crypto.randomUUID()}`;
    try {
      const result = await adapter.payLoan(
        workspaceId,
        payingLoan,
        { amount: { currency, minor: paymentMinor }, occurredOn: paymentDate },
        paymentCommandKey.current,
      );
      setLoans((current) =>
        current.map((loan) => (loan.id === result.loan.id ? result.loan : loan)),
      );
      setPayments((current) => ({
        ...current,
        [result.loan.id]: upsertLoanPayment(current[result.loan.id] ?? [], result.payment),
      }));
      setPayingLoan(null);
      setNotice(
        result.loan.status === "settled"
          ? "Pagamento registrado. Empréstimo quitado."
          : "Pagamento registrado. O saldo restante foi atualizado.",
      );
      paymentCommandKey.current = null;
    } catch (cause) {
      if (cause instanceof LoansAdapterError && cause.status === 412) {
        paymentCommandKey.current = null;
        setPayingLoan(null);
        await load();
        setNotice("O empréstimo mudou enquanto você o revisava. Recarregamos os dados.");
      } else {
        setFormError(
          cause instanceof Error ? cause.message : "Não foi possível registrar o pagamento.",
        );
      }
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Lembretes de dinheiro entre pessoas</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Empréstimos</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Registre o principal que saiu ou entrou da carteira. Pagamentos reduzem o saldo sem
            virar renda ou despesa.
          </p>
        </div>
        {writable ? (
          <Button type="button" className="min-h-11 w-full sm:w-fit" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Novo empréstimo
          </Button>
        ) : (
          <StatusBadge status="neutral">Somente leitura</StatusBadge>
        )}
      </header>

      {notice ? (
        <Alert>
          <CheckCircle2Icon aria-hidden="true" />
          <AlertTitle>Pronto</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {status === "success" || status === "empty" ? (
        <>
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Resumo dos empréstimos">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>A receber</CardDescription>
                <CardTitle className="text-2xl">
                  {formatMoneyMinor(toReceive.toString(), currency)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                <SendIcon aria-hidden="true" className="size-4" />
                <span>Dinheiro que deve voltar para você</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>A pagar</CardDescription>
                <CardTitle className="text-2xl">
                  {formatMoneyMinor(toPay.toString(), currency)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                <WalletCardsIcon aria-hidden="true" className="size-4" />
                <span>Dinheiro que você precisa devolver</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Contratos em aberto</CardDescription>
                <CardTitle className="text-2xl">{openCount}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleDollarSignIcon aria-hidden="true" className="size-4" />
                <span>Quitados continuam no histórico</span>
              </CardContent>
            </Card>
          </section>

          {status === "empty" ? (
            <AsyncState
              status="empty"
              title="Nenhum empréstimo registrado"
              description="Anote quando emprestar ou pegar dinheiro. Assim o saldo e o lembrete de vencimento ficam no mesmo lugar."
              action={
                writable
                  ? { label: "Registrar primeiro empréstimo", onClick: openCreate }
                  : undefined
              }
            />
          ) : (
            <section aria-labelledby="loan-list-title" className="flex flex-col gap-4">
              <div>
                <h3 id="loan-list-title" className="text-lg font-semibold">
                  Seus contratos
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Cada valor abaixo é principal restante, sem juros ou tarifas.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {loans.map((loan) => (
                  <LoanCard
                    key={loan.id}
                    loan={loan}
                    currency={currency}
                    today={today}
                    payments={payments[loan.id] ?? []}
                    writable={writable}
                    onPay={openPayment}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <AsyncState
          status={status}
          title={status === "permission" ? "Empréstimos indisponíveis" : undefined}
          description={error ?? undefined}
          action={
            status === "error" || status === "offline"
              ? { label: "Tentar novamente", onClick: () => void load() }
              : undefined
          }
        />
      )}

      <Link
        href="/app/finances"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" /> Voltar para Finanças
      </Link>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo empréstimo</DialogTitle>
            <DialogDescription>
              Registre somente o principal. O movimento altera a carteira, mas não é classificado
              como renda ou despesa.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submitCreate(event)}>
            <Field>
              <FieldLabel htmlFor="loan-direction">O dinheiro foi</FieldLabel>
              <select
                id="loan-direction"
                name="direction"
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={direction}
                onChange={(event) => setDirection(event.target.value as Loan["direction"])}
              >
                <option value="lent">Emprestado por mim</option>
                <option value="borrowed">Emprestado para mim</option>
              </select>
              <FieldDescription>Escolha quem deverá devolver o principal.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="loan-counterparty">Com quem foi</FieldLabel>
              <Input
                id="loan-counterparty"
                name="counterparty"
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
                maxLength={200}
                required
                autoComplete="name"
              />
            </Field>
            <MoneyInput
              id="loan-principal"
              value={principalMinor}
              onChange={setPrincipalMinor}
              currency={currency}
              label="Principal"
              autoFocus
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="loan-occurred-on">Data</FieldLabel>
                <Input
                  id="loan-occurred-on"
                  name="occurredOn"
                  type="date"
                  value={occurredOn}
                  onChange={(event) => setOccurredOn(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="loan-due-on">Vencimento (opcional)</FieldLabel>
                <Input
                  id="loan-due-on"
                  name="dueOn"
                  type="date"
                  value={dueOn}
                  min={occurredOn}
                  onChange={(event) => setDueOn(event.target.value)}
                />
              </Field>
            </div>
            {formError ? <FieldError>{formError}</FieldError> : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Salvando…" : "Salvar empréstimo"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={payingLoan !== null}
        onOpenChange={(open) => {
          if (!open && !paying) setPayingLoan(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar pagamento</DialogTitle>
            <DialogDescription>
              {payingLoan
                ? `${loanCounterpartyAction(payingLoan.direction)} de ${payingLoan.counterparty}: ${formatMoneyMinor(payingLoan.remaining.minor, currency)} restantes.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {payingLoan ? (
            <form className="flex flex-col gap-4" onSubmit={(event) => void submitPayment(event)}>
              <MoneyInput
                id="loan-payment"
                value={paymentMinor}
                onChange={setPaymentMinor}
                currency={currency}
                label="Valor do pagamento"
                autoFocus
              />
              <Field>
                <FieldLabel htmlFor="loan-payment-date">Data do pagamento</FieldLabel>
                <Input
                  id="loan-payment-date"
                  name="paymentDate"
                  type="date"
                  min={payingLoan.occurredOn}
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                  required
                />
              </Field>
              <Alert>
                <HandCoinsIcon aria-hidden="true" />
                <AlertTitle>Somente principal</AlertTitle>
                <AlertDescription>
                  Este registro movimenta a carteira e reduz o saldo do contrato. Juros e tarifas
                  ficam fora desta versão.
                </AlertDescription>
              </Alert>
              {formError ? <FieldError>{formError}</FieldError> : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPayingLoan(null)}
                  disabled={paying}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={paying}>
                  {paying ? "Registrando…" : "Confirmar pagamento"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
