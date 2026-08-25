"use client";

import { SearchIcon, ShieldAlertIcon, UserCheckIcon, UserRoundIcon, XIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

import { AsyncState } from "@/components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type AdminAccountDetail,
  type AdminAccountSummary,
  AdminAdapterError,
  authenticatedAdminAdapter,
} from "@/lib/admin";

type ListState = "idle" | "loading" | "success" | "empty" | "error" | "offline" | "permission";
type AccountAction =
  | "suspend"
  | "reactivate"
  | "role"
  | "verification"
  | "recovery"
  | "session"
  | null;

function accountStatusLabel(status: AdminAccountSummary["status"]): string {
  return status === "suspended" ? "Suspensa" : "Ativa";
}

function roleLabel(role: AdminAccountSummary["role"]): string {
  if (role === "platform_admin") return "Admin da plataforma";
  if (role === "platform_support") return "Suporte da plataforma";
  return "Sem papel de plataforma";
}

function formatDate(value: string | null): string {
  if (!value) return "Nunca";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default function AdminAccountsPage() {
  const [query, setQuery] = useState("");
  const [listState, setListState] = useState<ListState>("idle");
  const [accounts, setAccounts] = useState<AdminAccountSummary[]>([]);
  const [selected, setSelected] = useState<AdminAccountDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<AccountAction>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [role, setRole] = useState<"platform_admin" | "platform_support" | "none">(
    "platform_support",
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    const term = query.trim();
    if (!term) {
      setError("Informe um ID ou e-mail para buscar.");
      setListState("error");
      return;
    }
    setListState("loading");
    setError(null);
    setSelected(null);
    setSelectedId(null);
    try {
      const result = await authenticatedAdminAdapter.searchAccounts(term);
      setAccounts(result.items);
      setListState(result.items.length === 0 ? "empty" : "success");
    } catch (caught) {
      const adapterError = caught instanceof AdminAdapterError ? caught : null;
      setListState(
        adapterError?.code === "offline"
          ? "offline"
          : adapterError?.status === 403
            ? "permission"
            : "error",
      );
      setError(adapterError?.message ?? "Não foi possível pesquisar as contas.");
    }
  }

  async function selectAccount(userId: string) {
    setSelectedId(userId);
    setActionError(null);
    try {
      setSelected(await authenticatedAdminAdapter.getAccount(userId));
    } catch (caught) {
      setSelected(null);
      setError(
        caught instanceof AdminAdapterError ? caught.message : "Não foi possível carregar a conta.",
      );
    }
  }

  function openAction(
    nextAction: Exclude<AccountAction, null>,
    nextSessionId: string | null = null,
  ) {
    setAction(nextAction);
    setSessionId(nextSessionId);
    setReason("");
    setActionError(null);
    if (nextAction === "role") setRole(selected?.role ?? "platform_support");
  }

  async function confirmAction(event: FormEvent) {
    event.preventDefault();
    if (!selected || !reason.trim()) {
      setActionError("Informe o motivo para continuar.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      if (action === "session" && sessionId) {
        await authenticatedAdminAdapter.revokeSession(selected.userId, sessionId, reason);
        setAction(null);
        setSessionId(null);
        await selectAccount(selected.userId);
        return;
      }
      let updated = selected;
      if (action === "suspend")
        updated = await authenticatedAdminAdapter.suspend(selected.userId, reason);
      if (action === "reactivate")
        updated = await authenticatedAdminAdapter.reactivate(selected.userId, reason);
      if (action === "role") {
        updated = await authenticatedAdminAdapter.changeRole(
          selected.userId,
          role === "none" ? null : role,
          reason,
        );
      }
      if (action === "verification")
        await authenticatedAdminAdapter.resendVerification(selected.userId, reason);
      if (action === "recovery")
        await authenticatedAdminAdapter.resendRecovery(selected.userId, reason);
      setSelected(updated);
      setAccounts((current) =>
        current.map((item) => (item.userId === updated.userId ? updated : item)),
      );
      setAction(null);
    } catch (caught) {
      setActionError(
        caught instanceof AdminAdapterError ? caught.message : "Não foi possível concluir a ação.",
      );
    } finally {
      setActionBusy(false);
    }
  }

  const actionTitle =
    action === "suspend"
      ? "Suspender login"
      : action === "reactivate"
        ? "Reativar login"
        : action === "role"
          ? "Alterar papel da plataforma"
          : action === "verification"
            ? "Reenviar verificação"
            : action === "session"
              ? "Revogar sessão"
              : "Reenviar recuperação";

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Contas</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Consulte somente metadados mínimos. Nenhum valor, descrição, produto ou conteúdo doméstico
          aparece aqui.
        </p>
      </header>

      <search>
        <form className="rounded-xl border bg-background p-4" onSubmit={search}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-search">ID ou e-mail normalizado</FieldLabel>
              <FieldDescription>
                Buscas por e-mail não diferenciam maiúsculas e minúsculas.
              </FieldDescription>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="account-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoComplete="off"
                  inputMode="email"
                  placeholder="person@example.com"
                />
                <Button type="submit" className="min-h-11 sm:min-h-8">
                  <SearchIcon data-icon="inline-start" aria-hidden="true" />
                  Buscar conta
                </Button>
              </div>
            </Field>
          </FieldGroup>
        </form>
      </search>

      {error && listState === "error" && !query.trim() ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {listState === "idle" ? (
        <AsyncState
          status="empty"
          title="Nenhuma busca executada"
          description="Informe um ID ou e-mail para começar."
        />
      ) : listState === "loading" ? (
        <AsyncState status="loading" />
      ) : listState === "empty" ? (
        <AsyncState
          status="empty"
          title="Conta não encontrada"
          description="Revise o ID ou e-mail e tente novamente."
        />
      ) : listState === "offline" ? (
        <AsyncState
          status="offline"
          title="API indisponível"
          description={error ?? undefined}
          action={{ label: "Tentar novamente", onClick: () => void search() }}
        />
      ) : listState === "permission" ? (
        <AsyncState
          status="permission"
          title="Acesso administrativo negado"
          description="Sua sessão não possui capacidade para consultar contas."
        />
      ) : listState === "error" ? (
        <AsyncState
          status="error"
          title="Busca não concluída"
          description={error ?? undefined}
          action={{ label: "Tentar novamente", onClick: () => void search() }}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
          <section aria-labelledby="results-title" className="flex flex-col gap-3">
            <h2 id="results-title" className="text-sm font-medium text-muted-foreground">
              Resultados
            </h2>
            <ul className="flex flex-col gap-2">
              {accounts.map((account) => (
                <li key={account.userId}>
                  <button
                    type="button"
                    onClick={() => void selectAccount(account.userId)}
                    className="flex min-h-16 w-full flex-col items-start gap-1 rounded-xl border bg-background p-3 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 hover:bg-muted/40"
                    aria-current={selectedId === account.userId ? "true" : undefined}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-medium">{account.displayName}</span>
                      <Badge variant={account.status === "suspended" ? "destructive" : "secondary"}>
                        {accountStatusLabel(account.status)}
                      </Badge>
                    </span>
                    <span className="max-w-full truncate text-sm text-muted-foreground">
                      {account.email}
                    </span>
                    <span className="text-xs text-muted-foreground">{roleLabel(account.role)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected ? (
            <section
              aria-labelledby="account-detail-title"
              className="flex flex-col gap-4 rounded-xl border bg-background p-4 sm:p-6"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Detalhes mínimos</p>
                  <h2 id="account-detail-title" className="mt-1 text-xl font-semibold">
                    {selected.displayName}
                  </h2>
                  <p className="text-sm text-muted-foreground">{selected.email}</p>
                </div>
                <Badge variant={selected.status === "suspended" ? "destructive" : "secondary"}>
                  {accountStatusLabel(selected.status)}
                </Badge>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="break-all font-mono text-xs">{selected.userId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Papel</dt>
                  <dd>{roleLabel(selected.role)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Criada em</dt>
                  <dd>{formatDate(selected.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Última atividade</dt>
                  <dd>{formatDate(selected.lastActivityAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Espaços</dt>
                  <dd>{selected.workspaceCount}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Sessões ativas</dt>
                  <dd>{selected.activeSessionCount}</dd>
                </div>
              </dl>
              {actionError ? (
                <p role="alert" className="text-sm text-destructive">
                  {actionError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {selected.status === "suspended" ? (
                  <Button type="button" variant="outline" onClick={() => openAction("reactivate")}>
                    <UserCheckIcon data-icon="inline-start" aria-hidden="true" /> Reativar login
                  </Button>
                ) : (
                  <Button type="button" variant="destructive" onClick={() => openAction("suspend")}>
                    <ShieldAlertIcon data-icon="inline-start" aria-hidden="true" /> Suspender login
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => openAction("role")}>
                  <UserRoundIcon data-icon="inline-start" aria-hidden="true" /> Alterar papel
                </Button>
                <Button type="button" variant="outline" onClick={() => openAction("verification")}>
                  Reenviar verificação
                </Button>
                <Button type="button" variant="outline" onClick={() => openAction("recovery")}>
                  Reenviar recuperação
                </Button>
              </div>

              <div className="flex flex-col gap-3 border-t pt-4">
                <h3 className="font-medium">Sessões</h3>
                {selected.sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma sessão ativa.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {selected.sessions.map((session) => (
                      <li
                        key={session.id}
                        className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 text-sm">
                          <p className="truncate">
                            {session.userAgent ?? "Navegador não informado"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Criada {formatDate(session.createdAt)} · IP{" "}
                            {session.ipAddress ?? "não informado"}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 sm:min-h-8"
                          onClick={() => openAction("session", session.id)}
                        >
                          <XIcon data-icon="inline-start" aria-hidden="true" /> Revogar
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionTitle}</DialogTitle>
            <DialogDescription>
              Esta ação será auditada com o motivo informado e não permite acesso ao conteúdo
              doméstico.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={confirmAction} className="flex flex-col gap-4">
            {action === "role" ? (
              <Field>
                <FieldLabel htmlFor="platform-role">Novo papel</FieldLabel>
                <select
                  id="platform-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as typeof role)}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="platform_admin">Admin da plataforma</option>
                  <option value="platform_support">Suporte da plataforma</option>
                  <option value="none">Sem papel</option>
                </select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="admin-action-reason">Motivo obrigatório</FieldLabel>
              <Input
                id="admin-action-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                autoComplete="off"
                required
                minLength={1}
                maxLength={500}
              />
            </Field>
            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAction(null)}
                disabled={actionBusy}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={actionBusy || !reason.trim()}>
                {actionBusy ? "Enviando…" : "Confirmar ação"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
