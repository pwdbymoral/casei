"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

export default function InvitationPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "unauthenticated" | "error">("loading");
  const [message, setMessage] = useState("Verificando seu convite…");

  useEffect(() => {
    const token = params.token;
    if (!token) return;
    let canceled = false;
    void fetch(`${apiOrigin()}/v1/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (canceled) return;
        if (response.status === 401) {
          setState("unauthenticated");
          setMessage("Entre com o e-mail que recebeu este convite para aceitá-lo.");
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setState("error");
          setMessage(body?.error?.message ?? "Este convite não está mais disponível.");
          return;
        }
        router.replace("/app");
      })
      .catch(() => {
        if (!canceled) {
          setState("error");
          setMessage("Não foi possível conectar ao Casei. Tente novamente.");
        }
      });
    return () => {
      canceled = true;
    };
  }, [params.token, router]);

  const loginHref = `/login?invite=${encodeURIComponent(params.token ?? "")}`;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <section
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-sm"
        aria-live="polite"
      >
        <h1 className="text-xl font-semibold">Convite para um espaço</h1>
        <div className="mt-5">
          <AsyncState status={state === "loading" ? "loading" : "error"} description={message} />
        </div>
        {state === "unauthenticated" ? (
          <Link href={loginHref} className={cn(buttonVariants(), "mt-5 w-full")}>
            Entrar para aceitar
          </Link>
        ) : null}
        {state === "error" ? (
          <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "mt-5 w-full")}>
            Voltar para o início
          </Link>
        ) : null}
      </section>
    </main>
  );
}
