"use client";

import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AdminAdapterError, authenticatedAdminAdapter } from "@/lib/admin";

export function AdminTwoFactorEnrollment() {
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    try {
      const result = await authenticatedAdminAdapter.startTwoFactorEnrollment(password);
      setTotpURI(result.totpURI);
      setBackupCodes(result.backupCodes);
    } catch (caught) {
      setError(
        caught instanceof AdminAdapterError
          ? caught.message
          : "Não foi possível iniciar o cadastro.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyEnrollment() {
    setBusy(true);
    setError(null);
    try {
      await authenticatedAdminAdapter.verifyTwoFactorEnrollment(code);
      window.location.reload();
    } catch (caught) {
      setError(
        caught instanceof AdminAdapterError ? caught.message : "Código inválido. Tente novamente.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[60dvh] items-center justify-center p-6">
      <section
        className="w-full max-w-2xl rounded-2xl border bg-background p-6 shadow-sm"
        aria-labelledby="admin-2fa-title"
      >
        <h1 id="admin-2fa-title" className="text-xl font-semibold">
          Proteja o console administrativo
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Antes de acessar contas e sessões, cadastre um autenticador. O código será exigido em cada
          ação administrativa sensível.
        </p>
        {error ? (
          <Alert variant="destructive" className="mt-5">
            <AlertTitle>Não foi possível continuar</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {!totpURI ? (
          <form
            className="mt-6"
            onSubmit={(event) => {
              event.preventDefault();
              void startEnrollment();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="admin-2fa-password">Senha atual</FieldLabel>
                <Input
                  id="admin-2fa-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <FieldDescription>
                  Usamos a senha apenas para autorizar a configuração no Better Auth.
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? "Gerando…" : "Gerar cadastro"}
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <div className="mt-6 space-y-5">
            <Field>
              <FieldLabel htmlFor="admin-2fa-uri">URI do autenticador</FieldLabel>
              <FieldDescription>
                Copie a URI para seu autenticador. Em produção, ela deve ser tratada como segredo.
              </FieldDescription>
              <textarea
                id="admin-2fa-uri"
                readOnly
                value={totpURI}
                className="min-h-24 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs"
              />
            </Field>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verifyEnrollment();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="admin-2fa-code">Código de 6 dígitos</FieldLabel>
                  <Input
                    id="admin-2fa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                    minLength={6}
                    maxLength={8}
                  />
                </Field>
                <Button type="submit" disabled={busy}>
                  {busy ? "Verificando…" : "Verificar e entrar no console"}
                </Button>
              </FieldGroup>
            </form>
            <div className="rounded-lg border bg-muted/30 p-4" aria-live="polite">
              <p className="text-sm font-medium">Códigos de recuperação</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Guarde estes códigos em um local seguro. Cada um pode ser usado uma única vez.
              </p>
              <code className="mt-3 grid grid-cols-2 gap-2 text-sm">
                {backupCodes.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </code>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
