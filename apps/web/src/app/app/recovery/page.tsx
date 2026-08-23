"use client";

import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { authenticatedWorkspaceAdapter, type WorkspaceSession } from "@/lib/workspaces";

type RecoveryView = { status: "active" | "expired"; recoveryUntil: string; version: number };

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

export default function RecoveryPage() {
  const router = useRouter();
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspace = useMemo(
    () =>
      session?.workspaces.find(({ status }) => status === "deletion_pending") ??
      session?.workspaces.find(({ id }) => id === session.activeWorkspaceId) ??
      session?.workspaces[0] ??
      null,
    [session],
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const nextSession = await authenticatedWorkspaceAdapter.getSession();
        if (!mounted) return;
        setSession(nextSession);
        const nextWorkspace =
          nextSession.workspaces.find(({ status }) => status === "deletion_pending") ??
          nextSession.workspaces.find(({ id }) => id === nextSession.activeWorkspaceId) ??
          nextSession.workspaces[0];
        if (nextWorkspace?.status !== "deletion_pending") {
          router.replace("/app");
          return;
        }
        const response = await fetch(
          `${apiOrigin()}/v1/workspaces/${encodeURIComponent(nextWorkspace.id)}/recovery`,
          { credentials: "include", headers: { Accept: "application/json" }, cache: "no-store" },
        );
        if (!response.ok) throw new Error("Não foi possível carregar o estado de recuperação.");
        if (mounted) setRecovery((await response.json()) as RecoveryView);
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : "Tente novamente.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [router]);

  async function cancel() {
    if (!workspace || !recovery || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiOrigin()}/v1/workspaces/${encodeURIComponent(workspace.id)}/recovery/cancel`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "If-Match": `"v${recovery.version}"` },
        },
      );
      if (!response.ok) throw new Error("A janela de recuperação pode ter expirado.");
      window.location.assign("/app");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível recuperar o espaço.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <AsyncState
        status="loading"
        title="Carregando recuperação"
        description="Só o estado da recuperação será consultado."
      />
    );
  }
  if (error && !recovery) {
    return <AsyncState status="error" title="Recuperação indisponível" description={error} />;
  }
  if (!workspace || !recovery) return null;

  const until = new Date(recovery.recoveryUntil).toLocaleString("pt-BR", {
    dateStyle: "long",
    timeStyle: "short",
  });
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <Link href="/app" className={cn(buttonVariants({ variant: "ghost", className: "w-fit" }))}>
        <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" /> Voltar
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>Recuperar {workspace.name}</CardTitle>
          <CardDescription>
            O espaço está bloqueado e será excluído após o fim da janela. Nenhum dado doméstico é
            exibido nesta tela.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="rounded-lg border bg-muted/40 p-3 text-sm">
            {recovery.status === "active"
              ? `Você pode cancelar a exclusão até ${until}.`
              : "A janela de recuperação expirou."}
          </p>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            className="min-h-11"
            disabled={busy || recovery.status !== "active"}
            onClick={() => void cancel()}
          >
            <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
            {busy ? "Recuperando…" : "Cancelar exclusão e recuperar espaço"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
