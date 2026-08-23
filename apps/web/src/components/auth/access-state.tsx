import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function UnauthenticatedState() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <section
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-sm"
        aria-labelledby="auth-required-title"
      >
        <h1 id="auth-required-title" className="text-xl font-semibold">
          Entre para continuar
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Sua sessão é necessária para acessar dados do Casei. Nenhum conteúdo foi carregado.
        </p>
        <Link href="/login" className={cn(buttonVariants(), "mt-6 w-full")}>
          Entrar
        </Link>
      </section>
    </main>
  );
}

export function AdminAccessDeniedState() {
  return (
    <main className="flex min-h-[60dvh] items-center justify-center">
      <div className="w-full max-w-lg">
        <Alert>
          <AlertTitle>Acesso administrativo não disponível</AlertTitle>
          <AlertDescription>
            Esta área exige uma sessão de plataforma autorizada. O acesso ao conteúdo de espaços
            nunca é concedido por este endereço.
          </AlertDescription>
        </Alert>
      </div>
    </main>
  );
}
