"use client";

import type { LucideIcon } from "lucide-react";
import {
  BarChart3Icon,
  ChevronDownIcon,
  CircleHelpIcon,
  HomeIcon,
  LogOutIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  TargetIcon,
  WalletCardsIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { AsyncState, type AsyncStateStatus } from "@/components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  clearWorkspaceClientState,
  fixtureWorkspaceAdapter,
  getActiveWorkspace,
  unauthenticatedWorkspaceAdapter,
  type WorkspaceAdapter,
  type WorkspaceSession,
  WorkspaceSessionError,
} from "@/lib/workspaces";

type AppShellProps = {
  children: ReactNode;
  adapter?: WorkspaceAdapter;
  adapterMode?: "fixture" | "unauthenticated";
  initialSession?: WorkspaceSession;
  onLogout?: () => Promise<void>;
};

const primaryNav = [
  { href: "/app", label: "Hoje", icon: HomeIcon },
  { href: "/app/finances", label: "Finanças", icon: WalletCardsIcon },
  { href: "/app/goals", label: "Metas", icon: TargetIcon },
  { href: "/app/home", label: "Casa", icon: BarChart3Icon },
] as const;

const secondaryNav = [
  { href: "/app/reports", label: "Relatórios", icon: BarChart3Icon },
  { href: "/app/settings", label: "Configurações", icon: SettingsIcon },
  { href: "/app/help", label: "Ajuda", icon: CircleHelpIcon },
] as const;

function isActivePath(pathname: string, href: string): boolean {
  return href === "/app" ? pathname === href : pathname.startsWith(href);
}

type NavItem = { href: string; label: string; icon: LucideIcon };

function AppNavLink({
  href,
  label,
  icon: Icon,
  pathname,
  onNavigate,
}: NavItem & {
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isActivePath(pathname, href);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

function WorkspaceSelect({
  session,
  adapter,
  onChanged,
}: {
  session: WorkspaceSession;
  adapter: WorkspaceAdapter;
  onChanged: (session: WorkspaceSession) => void;
}) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspace = getActiveWorkspace(session);
  const router = useRouter();

  async function handleChange(workspaceId: string) {
    if (workspaceId === session.activeWorkspaceId || switching) return;
    setSwitching(true);
    setError(null);
    try {
      const nextSession = await adapter.switchWorkspace(workspaceId);
      onChanged(nextSession);
      // The active space is a cache boundary; restart at Hoje in its scope.
      router.replace("/app");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível trocar de espaço.");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="relative min-w-0">
      <label className="sr-only" htmlFor="active-workspace">
        Espaço ativo
      </label>
      <div className="flex items-center gap-1 rounded-xl border bg-background px-2 focus-within:ring-3 focus-within:ring-ring/50">
        <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
        <select
          id="active-workspace"
          className="min-h-11 min-w-0 max-w-44 cursor-pointer appearance-none bg-transparent py-2 pr-6 text-sm font-medium outline-none sm:max-w-60"
          value={session.activeWorkspaceId ?? ""}
          onChange={(event) => void handleChange(event.target.value)}
          disabled={switching}
          aria-describedby={error ? "workspace-switch-error" : undefined}
        >
          {session.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon aria-hidden="true" className="pointer-events-none -ml-6" />
      </div>
      <span className="sr-only" id="workspace-switch-error" role="alert">
        {error}
      </span>
      <span className="sr-only">
        Papel{" "}
        {activeWorkspace?.role === "owner"
          ? "proprietário"
          : activeWorkspace?.role === "viewer"
            ? "leitor"
            : "membro"}
      </span>
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <main className="min-h-dvh bg-muted/30" aria-busy="true" aria-label="Carregando seu espaço">
      <div className="mx-auto flex min-h-dvh max-w-7xl items-center justify-center p-6">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-36 rounded-2xl" />
          <p className="text-center text-sm text-muted-foreground">Carregando seu espaço…</p>
        </div>
      </div>
    </main>
  );
}

export function AppShell({
  children,
  adapter: providedAdapter,
  adapterMode = "unauthenticated",
  initialSession,
  onLogout,
}: AppShellProps) {
  const adapter: WorkspaceAdapter =
    providedAdapter ??
    (adapterMode === "fixture" ? fixtureWorkspaceAdapter : unauthenticatedWorkspaceAdapter);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [session, setSession] = useState<WorkspaceSession | null>(initialSession ?? null);
  const [status, setStatus] = useState<AsyncStateStatus>(initialSession ? "success" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scopeRevoked, setScopeRevoked] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const router = useRouter();

  const loadSession = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const loaded = await adapter.getSession();
      setSession(loaded);
      setStatus(loaded.workspaces.length > 0 ? "success" : "empty");
    } catch (cause) {
      if (cause instanceof WorkspaceSessionError && cause.code === "permission_denied") {
        clearWorkspaceClientState();
        setSession(null);
        setScopeRevoked(true);
        return;
      }
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar seu espaço.");
    }
  }, [adapter]);

  useEffect(() => {
    if (!initialSession) void loadSession();
  }, [initialSession, loadSession]);

  useEffect(() => {
    const updateOnlineState = () => setIsOffline(!navigator.onLine);
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  const forcedStatus = searchParams.get("state") as AsyncStateStatus | null;

  useEffect(() => {
    if (forcedStatus !== "permission") return;
    clearWorkspaceClientState();
    setSession(null);
    setScopeRevoked(true);
  }, [forcedStatus]);

  const visibleStatus =
    forcedStatus && ["error", "permission", "offline"].includes(forcedStatus)
      ? forcedStatus
      : isOffline
        ? "offline"
        : status;
  const activeWorkspace = useMemo(() => (session ? getActiveWorkspace(session) : null), [session]);
  const addEnabled =
    !isOffline &&
    visibleStatus !== "permission" &&
    status === "success" &&
    activeWorkspace?.role !== "viewer" &&
    !loggingOut;

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      if (onLogout) await onLogout();
      else await adapter.signOut?.();
      clearWorkspaceClientState();
      setSession(null);
      router.replace("/");
    } catch (cause) {
      setLogoutError(
        cause instanceof Error ? cause.message : "Não foi possível sair. Tente novamente.",
      );
    } finally {
      setLoggingOut(false);
    }
  }

  if (scopeRevoked) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md">
          <AsyncState
            status="permission"
            title="Espaço indisponível"
            description="Seu acesso a este espaço mudou. O conteúdo local foi limpo; escolha outro espaço para continuar."
            action={{ label: "Criar ou aceitar espaço", onClick: () => router.push("/onboarding") }}
          />
        </div>
      </main>
    );
  }

  if (status === "loading" && !session) return <ShellSkeleton />;

  if (!session) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md">
          <AsyncState
            status="error"
            title="Não foi possível abrir o Casei"
            description={error ?? "Tente novamente em alguns instantes."}
            action={{ label: "Tentar novamente", onClick: () => void loadSession() }}
          />
        </div>
      </main>
    );
  }

  if (session.workspaces.length === 0) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md">
          <AsyncState
            status="empty"
            title="Crie seu primeiro espaço"
            description="Um espaço guarda seus dados separados e pode ser compartilhado depois."
            action={{ label: "Começar onboarding", onClick: () => router.push("/onboarding") }}
          />
        </div>
      </main>
    );
  }

  if (activeWorkspace?.status === "deletion_pending" && !pathname.startsWith("/app/recovery")) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-sm">
          <p className="text-sm font-medium text-primary">Recuperação disponível</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Este espaço está aguardando exclusão
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Os dados domésticos estão bloqueados durante a janela de recuperação. Você pode cancelar
            a exclusão antes do vencimento.
          </p>
          <Link
            href="/app/recovery"
            className={cn(buttonVariants({ className: "mt-6 min-h-11 w-full" }))}
          >
            Revisar e recuperar espaço
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-dvh bg-muted/30">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Pular para o conteúdo
      </a>

      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r bg-background lg:flex">
        <div className="flex min-h-20 items-center px-6">
          <Link
            href="/app"
            className="text-xl font-semibold tracking-tight"
            aria-label="Casei, ir para Hoje"
          >
            Casei
          </Link>
        </div>
        <div className="px-4">
          <WorkspaceSelect session={session} adapter={adapter} onChanged={setSession} />
        </div>
        <Separator className="my-5" />
        <nav aria-label="Áreas do espaço" className="flex flex-col gap-1 px-4">
          {primaryNav.map((item) => (
            <AppNavLink key={item.href} {...item} pathname={pathname} />
          ))}
        </nav>
        <Separator className="my-5" />
        <nav aria-label="Mais opções" className="flex flex-col gap-1 px-4">
          {secondaryNav.map((item) => (
            <AppNavLink key={item.href} {...item} pathname={pathname} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t p-4">
          <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {session.user.displayName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{session.user.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            className="justify-start"
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
          >
            <LogOutIcon data-icon="inline-start" aria-hidden="true" />
            {loggingOut ? "Saindo…" : "Sair"}
          </Button>
          {logoutError ? (
            <span className="sr-only" role="alert">
              {logoutError}
            </span>
          ) : null}
        </div>
      </aside>

      <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <DialogContent
          showCloseButton={false}
          className="inset-y-0 left-0 top-0 h-dvh w-[min(86vw,22rem)] max-w-none translate-x-0 translate-y-0 rounded-none p-4 sm:max-w-none lg:hidden"
        >
          <DialogHeader>
            <DialogTitle>Menu do espaço</DialogTitle>
            <DialogDescription>Escolha uma área ou troque o espaço ativo.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 px-2 py-2">
              <span className="text-lg font-semibold">Casei</span>
              <Button
                size="icon"
                variant="ghost"
                type="button"
                aria-label="Fechar menu"
                onClick={() => setMobileMenuOpen(false)}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </div>
            <div className="mt-4">
              <WorkspaceSelect session={session} adapter={adapter} onChanged={setSession} />
            </div>
            <Separator className="my-5" />
            <nav aria-label="Todas as áreas" className="flex flex-col gap-1">
              {[...primaryNav, ...secondaryNav].map((item) => (
                <AppNavLink
                  key={item.href}
                  {...item}
                  pathname={pathname}
                  onNavigate={() => setMobileMenuOpen(false)}
                />
              ))}
            </nav>
            <div className="mt-auto border-t pt-4">
              <Button
                variant="ghost"
                className="w-full justify-start"
                type="button"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                <LogOutIcon data-icon="inline-start" aria-hidden="true" />
                {loggingOut ? "Saindo…" : "Sair"}
              </Button>
              {logoutError ? (
                <span className="sr-only" role="alert">
                  {logoutError}
                </span>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex min-h-20 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-10">
            <Button
              className="lg:hidden"
              size="icon"
              variant="ghost"
              type="button"
              aria-label="Abrir menu"
              onClick={() => setMobileMenuOpen(true)}
            >
              <MenuIcon aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {activeWorkspace?.name ?? "Seu espaço"}
              </p>
              <h1 className="truncate text-lg font-semibold sm:text-xl">
                {pathname === "/app" ? "Hoje" : "Seu espaço"}
              </h1>
            </div>
            <div className="lg:hidden">
              <WorkspaceSelect session={session} adapter={adapter} onChanged={setSession} />
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <Badge variant="outline">
                {activeWorkspace?.role === "owner"
                  ? "Proprietário"
                  : activeWorkspace?.role === "viewer"
                    ? "Leitor"
                    : "Membro"}
              </Badge>
              <span
                className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold"
                aria-label={`Perfil de ${session.user.displayName}`}
                role="img"
              >
                {session.user.displayName.slice(0, 1)}
              </span>
            </div>
          </div>
        </header>

        <main
          id="main-content"
          className="mx-auto min-h-[calc(100dvh-5rem)] max-w-7xl px-4 py-6 pb-28 sm:px-6 lg:px-10 lg:pb-10"
        >
          {isOffline ? (
            <div
              className="mb-5 rounded-xl border border-dashed bg-background px-4 py-3 text-sm text-muted-foreground"
              role="status"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <strong className="text-foreground">Você está offline.</strong>
                <span>
                  O conteúdo exibido pode estar desatualizado; alterações ficam desabilitadas.
                </span>
              </div>
            </div>
          ) : null}
          {visibleStatus !== "success" ? (
            <AsyncState
              status={visibleStatus}
              title={visibleStatus === "permission" ? "Este espaço não está disponível" : undefined}
              description={
                visibleStatus === "permission"
                  ? "Sua permissão mudou. Escolha outro espaço para continuar."
                  : (error ?? undefined)
              }
              action={
                visibleStatus === "error"
                  ? { label: "Tentar novamente", onClick: () => void loadSession() }
                  : undefined
              }
            >
              {children}
            </AsyncState>
          ) : (
            children
          )}
        </main>
      </div>

      <Link
        href="/app/add"
        aria-disabled={!addEnabled}
        tabIndex={addEnabled ? undefined : -1}
        onClick={(event) => {
          if (!addEnabled) event.preventDefault();
        }}
        className={cn(
          buttonVariants({ size: "lg" }),
          "fixed right-4 bottom-20 z-20 min-h-12 rounded-full px-5 shadow-lg sm:right-6 lg:right-10 lg:bottom-10",
          !addEnabled && "pointer-events-none opacity-50",
        )}
      >
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        <span>Adicionar</span>
      </Link>

      <nav
        aria-label="Navegação principal"
        className="fixed right-0 bottom-0 left-0 z-10 border-t bg-background/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-xl grid-cols-5 gap-1 py-2">
          {primaryNav.map(({ href, label, icon: Icon }) => {
            const active = isActivePath(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[0.68rem] font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[0.68rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setMobileMenuOpen(true)}
          >
            <MoreHorizontalIcon aria-hidden="true" />
            <span>Mais</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
