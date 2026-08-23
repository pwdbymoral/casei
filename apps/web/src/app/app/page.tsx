import {
  ArrowRightIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  ShoppingBasketIcon,
  TargetIcon,
} from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function TodayPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Bom dia, Marina</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Um passo de cada vez.
          </h2>
        </div>
        <StatusBadge status="success">Dados atualizados agora</StatusBadge>
      </section>

      <section className="grid gap-4 md:grid-cols-[1.25fr_1fr]" aria-label="Resumo financeiro">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader>
            <CardDescription className="text-primary-foreground/70">
              Saldo na carteira
            </CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">R$ 2.840,00</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-primary-foreground/80">
            <span>Sem lançamentos pendentes hoje.</span>
            <Link
              href="/app/finances"
              className="inline-flex min-h-11 items-center gap-1 font-medium text-primary-foreground underline-offset-4 hover:underline"
            >
              Ver carteira <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Valor seguro para gastar</CardDescription>
            <CardTitle className="text-3xl font-semibold tracking-tight">R$ 420,00</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>Próximos 30 dias · confiança média</span>
            <Link
              href="/app/finances#safe-to-spend"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Entender
            </Link>
          </CardContent>
        </Card>
      </section>

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

      <Alert>
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>Suas projeções ainda estão aprendendo.</AlertTitle>
        <AlertDescription>
          Registre uma receita ou despesa para aumentar a confiança do seu valor seguro para gastar.
        </AlertDescription>
      </Alert>

      <section className="grid gap-4 md:grid-cols-3" aria-label="Próximos cuidados">
        <Card>
          <CardHeader>
            <CalendarClockIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Próximos compromissos</CardTitle>
            <CardDescription>Nenhum vencimento nos próximos 7 dias.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/app/finances"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
            >
              Revisar planejamento
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <TargetIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Metas</CardTitle>
            <CardDescription>Crie uma reserva virtual sem alterar seu saldo.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/app/goals"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
            >
              Ver metas
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <ShoppingBasketIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Casa</CardTitle>
            <CardDescription>Nenhum item marcado como faltando.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/app/home"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
            >
              Abrir estoque
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
