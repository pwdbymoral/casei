import { ArrowLeftIcon, TargetIcon } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/primitives";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function GoalsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Reservas virtuais</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Metas</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Reserve dentro da carteira, acompanhe o ritmo e entenda quando uma meta fica em risco.
        </p>
      </header>
      <Card>
        <CardHeader>
          <TargetIcon aria-hidden="true" className="mb-2" />
          <CardTitle>Comece sua primeira meta</CardTitle>
          <CardDescription>
            O saldo total não muda; uma reserva apenas separa o que já é importante.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBadge status="neutral">Nenhuma meta criada</StatusBadge>
        </CardContent>
      </Card>
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
