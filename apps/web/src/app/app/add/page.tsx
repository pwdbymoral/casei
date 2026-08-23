import {
  ArrowLeftIcon,
  CreditCardIcon,
  PackagePlusIcon,
  PlusIcon,
  ReceiptTextIcon,
} from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const actions = [
  {
    href: "/app/add?type=expense",
    title: "Despesa",
    description: "Algo saiu da carteira.",
    icon: ReceiptTextIcon,
  },
  {
    href: "/app/add?type=income",
    title: "Receita",
    description: "Algo entrou na carteira.",
    icon: PlusIcon,
  },
  {
    href: "/app/add?type=card",
    title: "Compra no cartão",
    description: "Registre a compra e a fatura sugerida.",
    icon: CreditCardIcon,
  },
  {
    href: "/app/add?type=product",
    title: "Produto",
    description: "Adicione o que existe em casa.",
    icon: PackagePlusIcon,
  },
] as const;

export default function AddPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Captura rápida</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">O que aconteceu?</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Escolha o tipo para abrir o caminho mais curto. Você poderá completar os detalhes depois.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {actions.map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-xl border bg-background p-5 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Card className="border-0 bg-transparent shadow-none">
              <CardHeader className="p-0">
                <Icon aria-hidden="true" className="mb-3" />
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="p-0 pt-4 text-sm font-medium text-primary">
                Começar →
              </CardContent>
            </Card>
          </Link>
        ))}
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
