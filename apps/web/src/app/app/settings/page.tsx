"use client";

import {
  CopyIcon,
  MailPlusIcon,
  RefreshCwIcon,
  UserMinusIcon,
  UserRoundCogIcon,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AsyncState } from "@/components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  authenticatedWorkspaceAdapter,
  authenticatedWorkspaceManagementAdapter,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceSession,
} from "@/lib/workspaces";

const roleLabels = { owner: "proprietário", member: "membro", viewer: "leitor" } as const;
const management = authenticatedWorkspaceManagementAdapter;

export default function SettingsPage() {
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const workspace = useMemo(
    () =>
      session?.workspaces.find(({ id }) => id === session.activeWorkspaceId) ??
      session?.workspaces[0],
    [session],
  );
  const isOwner = workspace?.role === "owner";

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
        if (nextWorkspace) void load(nextWorkspace.id);
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
      const invitation = await management.createInvitation(workspace.id, {
        email: email.trim(),
        role,
      });
      setEmail("");
      setInviteUrl(invitation.inviteUrl ?? null);
      setMessage("Convite criado. Copie o link e envie para a pessoa.");
      await load(workspace.id);
    } catch (error) {
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
      setMessage("Alteração salva.");
      if (workspace) await load(workspace.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar a alteração.");
    } finally {
      setBusy(null);
    }
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
                            management.removeMember(workspace.id, member.userId),
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
                          management.revokeInvitation(workspace.id, invitation.id),
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
    </main>
  );
}
