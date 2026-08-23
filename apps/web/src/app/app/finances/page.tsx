import { ArrowLeftIcon, BarChart3Icon, WalletCardsIcon } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/primitives";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function FinancesPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Visão geral</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Finanças</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Quando os lançamentos estiverem conectados, esta área reunirá carteira, compromissos,
          cartões e projeções com a mesma fonte de verdade.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <WalletCardsIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Carteira</CardTitle>
            <CardDescription>Saldo atual e linha do tempo.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="info">Aguardando seus lançamentos</StatusBadge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <BarChart3Icon aria-hidden="true" className="mb-2" />
            <CardTitle>Planejamento</CardTitle>
            <CardDescription>Compromissos e valor seguro para gastar.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="warning">Confiança baixa</StatusBadge>
          </CardContent>
        </Card>
      </div>
      <Link
        href="/app"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" />
        Voltar para Hoje
      </Link>
    </div>
  );
}
