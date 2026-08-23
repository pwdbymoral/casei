import { ArrowLeftIcon, HomeIcon, ShoppingBasketIcon } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/primitives";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomeAreaPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Vida doméstica</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Casa</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Produtos e lista de compras ficam juntos, sem misturar atualização de estoque com despesa
          financeira.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <ShoppingBasketIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Lista de compras</CardTitle>
            <CardDescription>Itens que precisam entrar na próxima compra.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="success">Tudo em dia</StatusBadge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <HomeIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Estoque</CardTitle>
            <CardDescription>Cadastre um produto com apenas um nome.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="neutral">Nenhum produto ainda</StatusBadge>
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
