"use client";

import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  MailPlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
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
  authenticatedSettingsAdapter,
  preferenceChangeSummary,
  settingsErrorMessage,
  snapshotPreferencesDraft,
  type UserProfile,
  type WorkspacePreferences,
} from "@/lib/settings";
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
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [preferences, setPreferences] = useState<WorkspacePreferences | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [hideValues, setHideValues] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const [timeZone, setTimeZone] = useState("America/Fortaleza");
  const [safetyMarginMinor, setSafetyMarginMinor] = useState("0");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [preferencesPreview, setPreferencesPreview] = useState<Omit<
    WorkspacePreferences,
    "workspaceId" | "version"
  > | null>(null);
  const preferencesNameRef = useRef<HTMLInputElement>(null);
  const preferencesConfirmRef = useRef<HTMLButtonElement>(null);
  const restorePreferencesFocus = useRef(false);
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

  useEffect(() => {
    if (preferencesPreview) {
      preferencesConfirmRef.current?.focus();
      return;
    }
    if (restorePreferencesFocus.current) {
      restorePreferencesFocus.current = false;
      preferencesNameRef.current?.focus();
    }
  }, [preferencesPreview]);

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

  const load = useCallback(async (workspaceId: string, owner: boolean) => {
    setStatus("loading");
    try {
      const [nextProfile, nextPreferences] = await Promise.all([
        authenticatedSettingsAdapter.getProfile(),
        authenticatedSettingsAdapter.getWorkspacePreferences(workspaceId),
      ]);
      setProfile(nextProfile);
      setDisplayName(nextProfile.displayName);
      setHideValues(nextProfile.hideValues);
      setPreferences(nextPreferences);
      setWorkspaceName(nextPreferences.name);
      setCurrency(nextPreferences.currency);
      setTimeZone(nextPreferences.timeZone);
      setSafetyMarginMinor(nextPreferences.safetyMarginMinor);
      if (owner) {
        const [nextMembers, nextInvitations] = await Promise.all([
          management.listMembers(workspaceId),
          management.listInvitations(workspaceId),
        ]);
        setMembers(nextMembers);
        setInvitations(nextInvitations);
      }
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setMessage(settingsErrorMessage(error));
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
        if (nextWorkspace) void load(nextWorkspace.id, nextWorkspace.role === "owner");
      })
      .catch((error) => {
        if (!active) return;
        setStatus("error");
        setMessage(settingsErrorMessage(error));
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
      await load(workspace.id, true);
    } catch (error) {
      if (isTerminalActionError(error)) actionKeys.current.delete("invite");
      setMessage(settingsErrorMessage(error));
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
      if (workspace) await load(workspace.id, isOwner === true);
    } catch (error) {
      if (isTerminalActionError(error)) actionKeys.current.delete(action);
      setMessage(settingsErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || busy || !displayName.trim()) return;
    await run("profile", async () => {
      const next = await authenticatedSettingsAdapter.updateProfile(
        { displayName: displayName.trim(), locale: "pt-BR", hideValues },
        profile.version,
      );
      setProfile(next);
      setDisplayName(next.displayName);
      setHideValues(next.hideValues);
    });
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preferences || busy || !isOwner) return;
    setMessage(null);
    setPreferencesPreview(
      snapshotPreferencesDraft({
        name: workspaceName.trim(),
        currency: currency.toUpperCase(),
        timeZone: timeZone.trim(),
        safetyMarginMinor: safetyMarginMinor.trim() || "0",
      }),
    );
  }

  async function confirmPreferences() {
    if (!preferences || !preferencesPreview || busy || !isOwner) return;
    await run("preferences", async () => {
      const next = await authenticatedSettingsAdapter.updateWorkspacePreferences(
        preferences.workspaceId,
        preferencesPreview,
        preferences.version,
      );
      setPreferencesPreview(null);
      setPreferences(next);
      setWorkspaceName(next.name);
      setCurrency(next.currency);
      setTimeZone(next.timeZone);
      setSafetyMarginMinor(next.safetyMarginMinor);
      setSession((current) =>
        current
          ? {
              ...current,
              workspaces: current.workspaces.map((item) =>
                item.id === next.workspaceId
                  ? { ...item, name: next.name, timeZone: next.timeZone, version: next.version }
                  : item,
              ),
            }
          : current,
      );
    });
  }

  function cancelPreferencesPreview() {
    restorePreferencesFocus.current = true;
    setPreferencesPreview(null);
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !currentPassword || !newPassword) return;
    await run("password", async () => {
      await authenticatedSettingsAdapter.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
    });
  }

  async function requestEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !newEmail.trim()) return;
    await run("email", async () => {
      await authenticatedSettingsAdapter.changeEmail(newEmail.trim());
      setNewEmail("");
    });
  }

  async function resendVerification() {
    if (!profile || busy) return;
    await run("verification", async () => {
      await authenticatedSettingsAdapter.sendVerificationEmail(profile.email);
    });
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

      <section className="grid gap-6 lg:grid-cols-2" aria-label="Sua conta">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRoundCogIcon aria-hidden="true" /> Seu perfil
            </CardTitle>
            <CardDescription>
              Estas informações pertencem à sua conta e valem em todos os seus espaços.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {profile ? (
              <form className="grid gap-4" onSubmit={saveProfile}>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="profile-name">
                  Nome de exibição
                  <Input
                    id="profile-name"
                    value={displayName}
                    minLength={2}
                    maxLength={200}
                    disabled={busy !== null}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="min-h-11"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="profile-locale">
                  Idioma
                  <select
                    id="profile-locale"
                    className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={profile.locale}
                    disabled
                    aria-describedby="profile-locale-help"
                  >
                    <option value="pt-BR">Português (Brasil)</option>
                  </select>
                  <span id="profile-locale-help" className="text-xs text-muted-foreground">
                    Mais idiomas serão adicionados depois.
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={hideValues}
                    disabled={busy !== null}
                    onChange={(event) => setHideValues(event.target.checked)}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <span className="flex items-center gap-2 font-medium">
                      {hideValues ? (
                        <EyeOffIcon aria-hidden="true" />
                      ) : (
                        <EyeIcon aria-hidden="true" />
                      )}
                      Ocultar valores por padrão
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Telas financeiras poderão mostrar apenas que há um valor, sem revelar o
                      número.
                    </span>
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={busy !== null || !displayName.trim()}>
                    <SaveIcon aria-hidden="true" />{" "}
                    {busy === "profile" ? "Salvando…" : "Salvar perfil"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Idioma atual: {profile.locale}
                  </span>
                </div>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Carregando seu perfil…</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon aria-hidden="true" /> Segurança da conta
            </CardTitle>
            <CardDescription>
              Senhas nunca são exibidas ou armazenadas pelo Casei. A troca usa a proteção nativa da
              sua conta.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {profile ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div>
                  <p className="font-medium">{profile.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {profile.emailVerified ? "E-mail verificado" : "E-mail ainda não verificado"}
                  </p>
                </div>
                {!profile.emailVerified ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void resendVerification()}
                  >
                    {busy === "verification" ? "Enviando…" : "Reenviar verificação"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <form className="grid gap-3" onSubmit={changePassword}>
              <p className="text-sm font-medium">Trocar senha</p>
              <label className="grid gap-1.5 text-sm" htmlFor="current-password">
                Senha atual
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  disabled={busy !== null}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  className="min-h-11"
                />
              </label>
              <label className="grid gap-1.5 text-sm" htmlFor="new-password">
                Nova senha
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={newPassword}
                  disabled={busy !== null}
                  onChange={(event) => setNewPassword(event.target.value)}
                  className="min-h-11"
                />
              </label>
              <Button
                type="submit"
                variant="outline"
                disabled={busy !== null || !currentPassword || !newPassword}
              >
                <KeyRoundIcon aria-hidden="true" />{" "}
                {busy === "password" ? "Atualizando…" : "Atualizar senha"}
              </Button>
            </form>
            <form className="grid gap-3 border-t pt-5" onSubmit={requestEmailChange}>
              <p className="text-sm font-medium">Alterar e-mail</p>
              <label className="grid gap-1.5 text-sm" htmlFor="new-email">
                Novo e-mail
                <Input
                  id="new-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={newEmail}
                  disabled={busy !== null}
                  onChange={(event) => setNewEmail(event.target.value)}
                  className="min-h-11"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Você receberá uma confirmação antes de o novo endereço ser aplicado.
              </p>
              <Button type="submit" variant="outline" disabled={busy !== null || !newEmail.trim()}>
                <MailPlusIcon aria-hidden="true" />{" "}
                {busy === "email" ? "Enviando…" : "Solicitar alteração"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Preferências do espaço</CardTitle>
          <CardDescription>
            {isOwner
              ? "Defina como este espaço será apresentado. A moeda fica bloqueada depois do primeiro movimento financeiro."
              : "Você pode consultar estas preferências; somente o proprietário pode alterá-las."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preferences ? (
            <>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={savePreferences}>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="workspace-name">
                  Nome do espaço
                  <Input
                    id="workspace-name"
                    ref={preferencesNameRef}
                    value={workspaceName}
                    minLength={2}
                    maxLength={200}
                    disabled={!isOwner || busy !== null || preferencesPreview !== null}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    className="min-h-11"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="workspace-currency">
                  Moeda
                  <Input
                    id="workspace-currency"
                    value={currency}
                    maxLength={3}
                    disabled={!isOwner || busy !== null || preferencesPreview !== null}
                    onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                    className="min-h-11 uppercase"
                  />
                  <span className="text-xs text-muted-foreground">
                    Código ISO 4217, por exemplo BRL.
                  </span>
                </label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="workspace-timezone">
                  Fuso horário (IANA)
                  <Input
                    id="workspace-timezone"
                    value={timeZone}
                    disabled={!isOwner || busy !== null || preferencesPreview !== null}
                    onChange={(event) => setTimeZone(event.target.value)}
                    placeholder="America/Fortaleza"
                    className="min-h-11"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="workspace-margin">
                  Margem de segurança (centavos)
                  <Input
                    id="workspace-margin"
                    inputMode="numeric"
                    pattern="[0-9]+"
                    value={safetyMarginMinor}
                    disabled={!isOwner || busy !== null || preferencesPreview !== null}
                    onChange={(event) =>
                      setSafetyMarginMinor(event.target.value.replace(/[^0-9]/g, ""))
                    }
                    className="min-h-11"
                  />
                  <span className="text-xs text-muted-foreground">
                    Usada para preservar uma folga no orçamento.
                  </span>
                </label>
                {isOwner ? (
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <Button type="submit" disabled={busy !== null || !workspaceName.trim()}>
                      <SaveIcon aria-hidden="true" />{" "}
                      {busy === "preferences" ? "Salvando…" : "Salvar preferências"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Versão atual: {preferences.version}
                    </span>
                  </div>
                ) : null}
              </form>
              {preferencesPreview ? (
                <section
                  className="mt-5 grid gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4"
                  aria-labelledby="preferences-preview-title"
                  aria-describedby="preferences-preview-description"
                  aria-live="polite"
                >
                  <div>
                    <p id="preferences-preview-title" className="font-medium">
                      Revise antes de salvar
                    </p>
                    <p
                      id="preferences-preview-description"
                      className="text-sm text-muted-foreground"
                    >
                      Confirme as consequências para este espaço. O servidor ainda validará a versão
                      e a regra da moeda.
                    </p>
                  </div>
                  <ul className="grid gap-1 text-sm" aria-label="Alterações nas preferências">
                    {preferenceChangeSummary(preferences, preferencesPreview).map((change) => (
                      <li key={change}>• {change}</li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      ref={preferencesConfirmRef}
                      disabled={busy !== null}
                      onClick={() => void confirmPreferences()}
                    >
                      {busy === "preferences" ? "Salvando…" : "Confirmar e salvar"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={cancelPreferencesPreview}
                    >
                      Voltar e editar
                    </Button>
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Carregando preferências…</p>
          )}
        </CardContent>
      </Card>

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

      {isOwner ? (
        <section className="grid gap-6 lg:grid-cols-2" aria-label="Acesso ao espaço">
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2">
                <UserRoundCogIcon aria-hidden="true" /> Pessoas
              </CardTitle>
              <CardDescription>
                {members.length} pessoa(s) com registro neste espaço.
              </CardDescription>
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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Acesso ao espaço</CardTitle>
            <CardDescription>
              Seu papel é <span className="font-medium">{roleLabels[workspace.role]}</span>. A
              gestão de pessoas e convites fica disponível apenas para o proprietário.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {isOwner ? (
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
                O acesso aos dados domésticos será bloqueado e você poderá cancelar a exclusão
                durante 30 dias.
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
      ) : null}
    </main>
  );
}
