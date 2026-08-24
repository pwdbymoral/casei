"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireApiOrigin } from "@/lib/api-origin";
import { cn } from "@/lib/utils";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(
    searchParams.get("verified") ? "E-mail verificado. Entre para continuar." : null,
  );
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const path = mode === "sign-in" ? "sign-in/email" : "sign-up/email";
    const body =
      mode === "sign-in"
        ? { email, password, callbackURL: `${window.location.origin}/app` }
        : {
            name,
            email,
            password,
            callbackURL: `${window.location.origin}/login?verified=1${inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : ""}`,
          };
    try {
      const response = await fetch(`${requireApiOrigin()}/api/auth/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(result?.message ?? "Não foi possível concluir a operação.");
      if (mode === "sign-up") {
        setMessage(
          "Enviamos um link de verificação para seu e-mail. Depois, entre para continuar.",
        );
      } else {
        router.replace(inviteToken ? `/invite/${encodeURIComponent(inviteToken)}` : "/app");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <section
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-sm"
        aria-labelledby="login-title"
      >
        <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Casei
        </Link>
        <h1 id="login-title" className="mt-5 text-2xl font-semibold">
          {mode === "sign-in" ? "Entrar no Casei" : "Criar sua conta"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {mode === "sign-in"
            ? "Acesse seus espaços compartilhados com segurança."
            : "Comece seu espaço doméstico em poucos passos."}
        </p>
        {message ? (
          <div className="mt-5">
            <AsyncState status="success" description={message} />
          </div>
        ) : null}
        {error ? (
          <div className="mt-5">
            <AsyncState status="error" description={error} />
          </div>
        ) : null}
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {mode === "sign-up" ? (
            <div className="space-y-2">
              <Label htmlFor="name">Nome</Label>
              <Input
                id="name"
                autoComplete="name"
                required
                minLength={2}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Senha</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Aguarde…" : mode === "sign-in" ? "Entrar" : "Criar conta"}
          </Button>
        </form>
        <button
          type="button"
          className="mt-5 min-h-11 w-full text-sm font-medium underline-offset-4 hover:underline"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
            setMessage(null);
          }}
        >
          {mode === "sign-in" ? "Ainda não tenho uma conta" : "Já tenho uma conta"}
        </button>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "mt-3 w-full")}>
          Voltar para o início
        </Link>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-muted/30" aria-busy="true" />}>
      <LoginForm />
    </Suspense>
  );
}
