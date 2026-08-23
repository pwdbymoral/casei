import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The API identity boundary is delivered separately from the shell. Keeping a
 * real route here avoids a dead `/login` link while that boundary is wired to
 * the authenticated web adapter in AUTH-002.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <section
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-sm"
        aria-labelledby="login-title"
      >
        <h1 id="login-title" className="text-xl font-semibold">
          Entrar no Casei
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          A sessão segura está sendo conectada ao espaço compartilhado. Nenhum dado doméstico é
          carregado antes dessa conexão.
        </p>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "mt-6 w-full")}>
          Voltar para o início
        </Link>
      </section>
    </main>
  );
}
