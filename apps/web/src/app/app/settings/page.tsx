"use client";

import {
  CopyIcon,
  MailPlusIcon,
  RefreshCwIcon,
  UserMinusIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  authenticatedWorkspaceAdapter,
  authenticatedWorkspaceManagementAdapter,
  type WorkspaceInvitation,
  WorkspaceManagementError,
  type WorkspaceMember,
  type WorkspaceSession,
  WorkspaceSessionError,
} from "@/lib/workspaces";

const roleLabels = { owner: "proprietário", member: "membro", viewer: "leitor" } as const;
const management = authenticatedWorkspaceManagementAdapter;

export default function SettingsPage() {
  const router = useRouter();
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [transferUserId, setTransferUserId] = useState("");
  const [deactivationReason, setDeactivationReason] = useState("");
  const [deactivationName, setDeactivationName] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const workspace = useMemo(
    () =>
      session?.workspaces.find(({ id }) => id === session.activeWorkspaceId) ??
      session?.workspaces[0],
    [session],
  );
  const isOwner = workspace?.role === "owner";

  function isTerminalActionError(error: unknown): boolean {
    if (error instanceof WorkspaceManagementError) {
      return ![408, 425, 429].includes(error.status) && error.status >= 400 && error.status < 500;
    }
    return error instanceof WorkspaceSessionError && error.code !== "offline";
  }

  function actionIdempotencyKey(action: string): string {
    const existing = actionKeys.current.get(action);
    if (existing) return existing;
    const key = `${action}-${crypto.randomUUID()}`;
    actionKeys.current.set(action, key);
    return key;
  }

  const load = useCallback(async (workspaceId: string) => {
    setStatus("loading");
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        management.listMembers(workspaceId),
        management.listInvitations(workspaceId),
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar a gestão.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void authenticatedWorkspaceAdapter
      .getSession()
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        const nextWorkspace =
          nextSession.workspaces.find(({ id }) => id === nextSession.activeWorkspaceId) ??
          nextSession.workspaces[0];
        if (nextWorkspace?.role === "owner") void load(nextWorkspace.id);
      })
      .catch((error) => {
        if (!active) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Sua sessão não está disponível.");
      });
    return () => {
      active = false;
    };
  }, [load]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !email.trim() || busy) return;
    setBusy("invite");
    setMessage(null);
    try {
      const invitation = await management.createInvitation(
        workspace.id,
        {
          email: email.trim(),
          role,
        },
        actionIdempotencyKey("invite"),
      );
      setEmail("");
      setInviteUrl(invitation.inviteUrl ?? null);
      setMessage("Convite criado. Copie o link e envie para a pessoa.");
      actionKeys.current.delete("invite");
      await load(workspace.id);
    } catch (error) {
      if (isTerminalActionError(error)) actionKeys.current.delete("invite");
      setMessage(error instanceof Error ? error.message : "Não foi possível criar o convite.");
    } finally {
      setBusy(null);
    }
  }

  async function run(action: string, callback: () => Promise<void>) {
    if (busy) return;
    setBusy(action);
    setMessage(null);
    try {
      await callback();
      actionKeys.current.delete(action);
      setMessage("Alteração salva.");
      if (workspace) await load(workspace.id);
    } catch (error) {
      if (isTerminalActionError(error)) actionKeys.current.delete(action);
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar a alteração.");
    } finally {
      setBusy(null);
    }
  }

  async function transferOwnership() {
    if (!workspace || !transferUserId || busy) return;
    const target = members.find((member) => member.userId === transferUserId);
    if (target?.status !== "active" || target.role === "owner") return;
    if (!window.confirm(`Transferir a propriedade para ${target.displayName}?`)) return;
    await run("transfer-ownership", async () => {
      await management.transferOwnership(workspace.id, target.userId, workspace.version);
      window.location.assign("/app");
    });
  }

  async function deactivateWorkspace() {
    if (!workspace || busy || !deactivationName.trim() || !deactivationReason.trim()) return;
    if (deactivationName.trim() !== workspace.name) {
      setMessage("Digite o nome exato do espaço para confirmar a desativação.");
      return;
    }
    if (!window.confirm("O espaço ficará bloqueado durante 30 dias. Continuar?")) return;
    await run("deactivate-workspace", async () => {
      await management.deactivateWorkspace(
        workspace.id,
        { workspaceName: deactivationName.trim(), reason: deactivationReason.trim() },
        workspace.version,
      );
      router.replace("/app/recovery");
    });
  }

  if (status === "loading" && !session) {
    return (
      <AsyncState
        status="loading"
        title="Carregando configurações"
        description="Buscando seu espaço…"
      />
    );
  }
  if (status === "error" && !session) {
    return (
      <AsyncState
        status="error"
        title="Configurações indisponíveis"
        description={message ?? "Tente novamente."}
      />
    );
  }
  if (!workspace) {
    return (
      <AsyncState
        status="empty"
        title="Nenhum espaço ativo"
        description="Crie ou aceite um convite para continuar."
      />
    );
  }
  if (!isOwner) {
    return (
      <AsyncState
        status="permission"
        title="Configurações do owner"
        description="Somente o proprietário pode gerenciar pessoas, convites e permissões deste espaço."
      />
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-primary">Configurações</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Pessoas e acesso</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Controle quem participa de {workspace.name}. Convites usam links de uso único e a pessoa
          só entra com o e-mail para o qual foi convidada.
        </p>
      </header>

      {message ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm" role="status">
          {message}
        </p>
      ) : null}

      {inviteUrl ? (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle>Link do convite</CardTitle>
            <CardDescription>
              Envie este link por um canal seguro. Ele expira automaticamente.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Input
              aria-label="Link do convite criado"
              readOnly
              value={inviteUrl}
              className="min-h-11"
            />
            <Button
              type="button"
              className="min-h-11"
              onClick={() => void navigator.clipboard?.writeText(inviteUrl)}
            >
              <CopyIcon aria-hidden="true" /> Copiar link
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Convidar alguém</CardTitle>
            <CardDescription>
              Comece só com o e-mail; o papel pode ser ajustado depois.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end"
              onSubmit={invite}
            >
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="member-email">
                E-mail
                <Input
                  id="member-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="pessoa@exemplo.com"
                  className="min-h-11"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="member-role">
                Papel
                <select
                  id="member-role"
                  className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={role}
                  onChange={(event) => setRole(event.target.value as "member" | "viewer")}
                >
                  <option value="member">Membro</option>
                  <option value="viewer">Leitor</option>
                </select>
              </label>
              <Button type="submit" disabled={busy !== null} className="min-h-11">
                <MailPlusIcon aria-hidden="true" />{" "}
                {busy === "invite" ? "Criando…" : "Criar convite"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-2" aria-label="Acesso ao espaço">
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <UserRoundCogIcon aria-hidden="true" /> Pessoas
            </CardTitle>
            <CardDescription>{members.length} pessoa(s) com registro neste espaço.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {members.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nenhuma pessoa encontrada.</p>
            ) : null}
            {members.map((member) => (
              <div
                key={member.userId}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.displayName}</p>
                  <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={member.status === "active" ? "secondary" : "outline"}>
                    {member.status === "active" ? roleLabels[member.role] : member.status}
                  </Badge>
                  {isOwner && member.role !== "owner" && member.status === "active" ? (
                    <>
                      <label className="sr-only" htmlFor={`role-${member.userId}`}>
                        Papel de {member.displayName}
                      </label>
                      <select
                        id={`role-${member.userId}`}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        value={member.role}
                        disabled={busy !== null}
                        onChange={(event) =>
                          void run(`role-${member.userId}`, () =>
                            management.changeMemberRole(
                              workspace.id,
                              member.userId,
                              event.target.value as "member" | "viewer",
                              member.version,
                            ),
                          )
                        }
                      >
                        <option value="member">Membro</option>
                        <option value="viewer">Leitor</option>
                      </select>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => {
                          if (!window.confirm(`Remover ${member.displayName} deste espaço?`))
                            return;
                          void run(`remove-${member.userId}`, () =>
                            management.removeMember(workspace.id, member.userId, member.version),
                          );
                        }}
                      >
                        <UserMinusIcon data-icon="inline-start" aria-hidden="true" /> Remover
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <RefreshCwIcon aria-hidden="true" /> Convites
            </CardTitle>
            <CardDescription>Reenvie ou revogue convites pendentes.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {invitations.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nenhum convite registrado.</p>
            ) : null}
            {invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{invitation.email}</p>
                  <p className="text-sm text-muted-foreground">
                    {invitation.role === "member" ? "Membro" : "Leitor"} · {invitation.status}
                  </p>
                </div>
                {isOwner && invitation.status === "pending" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`resend-${invitation.id}`, async () => {
                          const next = await management.resendInvitation(
                            workspace.id,
                            invitation.id,
                            actionIdempotencyKey(`resend-${invitation.id}`),
                          );
                          setInviteUrl(next.inviteUrl ?? null);
                        })
                      }
                    >
                      Reenviar
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`revoke-${invitation.id}`, () =>
                          management.revokeInvitation(
                            workspace.id,
                            invitation.id,
                            actionIdempotencyKey(`revoke-${invitation.id}`),
                          ),
                        )
                      }
                    >
                      Revogar
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2" aria-label="Ações críticas do espaço">
        <Card>
          <CardHeader>
            <CardTitle>Transferir propriedade</CardTitle>
            <CardDescription>
              A outra pessoa se torna owner e você permanece como membro. A ação exige uma versão
              atualizada do espaço.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="transfer-member">
              Novo proprietário
              <select
                id="transfer-member"
                className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={transferUserId}
                disabled={busy !== null}
                onChange={(event) => setTransferUserId(event.target.value)}
              >
                <option value="">Selecione uma pessoa</option>
                {members
                  .filter((member) => member.status === "active" && member.role !== "owner")
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName} — {member.email}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!transferUserId || busy !== null}
              onClick={() => void transferOwnership()}
            >
              Transferir propriedade
            </Button>
          </CardContent>
        </Card>

        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle>Desativar espaço</CardTitle>
            <CardDescription>
              O acesso aos dados domésticos será bloqueado e você poderá cancelar a exclusão durante
              30 dias.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="deactivation-name">
              Digite o nome do espaço
              <Input
                id="deactivation-name"
                value={deactivationName}
                disabled={busy !== null}
                onChange={(event) => setDeactivationName(event.target.value)}
                className="min-h-11"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="deactivation-reason">
              Motivo
              <Input
                id="deactivation-reason"
                value={deactivationReason}
                disabled={busy !== null}
                onChange={(event) => setDeactivationReason(event.target.value)}
                placeholder="Por que você está desativando?"
                className="min-h-11"
              />
            </label>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={!deactivationName.trim() || !deactivationReason.trim() || busy !== null}
              onClick={() => void deactivateWorkspace()}
            >
              Desativar e iniciar janela de recuperação
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
