import { ArrowRightIcon, ChartNoAxesCombinedIcon, HouseIcon, TargetIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-5 py-6 sm:px-8 lg:px-12">
      <header className="flex items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">Casei</span>
        <Badge variant="secondary">Fundação em andamento</Badge>
      </header>

      <section className="flex flex-1 flex-col justify-center py-16 sm:py-24">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-muted-foreground">
            Uma vida, mais leve de cuidar.
          </p>
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Tudo o que importa para a vida em comum, no mesmo lugar.
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
            Planeje finanças, acompanhe metas e cuide da casa com clareza — sozinho, a dois ou em
            grupo.
          </p>
          <Button className="mt-8" render={<Link href="/onboarding" />}>
            Começar agora
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <ChartNoAxesCombinedIcon aria-hidden="true" className="mb-3" />
              <CardTitle>Finanças sem atrito</CardTitle>
              <CardDescription>Entenda o presente e planeje os próximos passos.</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground">
              Orçamentos e decisões que cabem na vida real.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <TargetIcon aria-hidden="true" className="mb-3" />
              <CardTitle>Metas em movimento</CardTitle>
              <CardDescription>Transforme intenções em progresso visível.</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground">
              Menos cobranças, mais pequenas vitórias.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <HouseIcon aria-hidden="true" className="mb-3" />
              <CardTitle>Casa sob controle</CardTitle>
              <CardDescription>Saiba o que há, falta e precisa acontecer.</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground">
              Organização compartilhada sem planilhas cansativas.
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
