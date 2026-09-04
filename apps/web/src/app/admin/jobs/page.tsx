"use client";

import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AsyncState } from "@/components/primitives";
import { useAdminPlatformRole } from "@/components/shell/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  AdminAdapterError,
  type AdminJob,
  type AdminJobState,
  type AdminJobType,
  authenticatedAdminAdapter,
  createAdminCommandKey,
} from "@/lib/admin";

const states: AdminJobState[] = ["pending", "running", "succeeded", "failed", "dead", "cancelled"];
const stateLabels: Record<AdminJobState, string> = {
  pending: "Na fila",
  running: "Executando",
  succeeded: "Concluído",
  failed: "Falhou",
  dead: "Dead-letter",
  cancelled: "Cancelado",
};
const typeLabels: Record<AdminJobType, string> = {
  "data.import": "Importação",
  "recurrence.expand": "Recorrência",
};
function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default function AdminJobsPage() {
  const role = useAdminPlatformRole();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [health, setHealth] = useState<Record<AdminJobState, number> | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "loading" | "success" | "empty" | "error" | "offline" | "permission"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<AdminJobType | "">(() => {
    const value = searchParams.get("type");
    return value === "data.import" || value === "recurrence.expand" ? value : "";
  });
  const [state, setState] = useState<AdminJobState | "">(() => {
    const value = searchParams.get("state");
    return states.includes(value as AdminJobState) ? (value as AdminJobState) : "";
  });
  const [selected, setSelected] = useState<AdminJob | null>(null);
  const [reason, setReason] = useState("");
  const [stepUpMethod, setStepUpMethod] = useState<"totp" | "backup_code">("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await authenticatedAdminAdapter.searchJobs({
        type: type || undefined,
        state: state || undefined,
        cursor,
      });
      setJobs((current) => (cursor ? [...current, ...result.data.items] : result.data.items));
      setHealth(result.data.health);
      setNextCursor(result.data.page.hasMore ? result.data.page.nextCursor : null);
      setStatus(cursor || result.data.items.length ? "success" : "empty");
    } catch (caught) {
      const e = caught instanceof AdminAdapterError ? caught : null;
      setStatus(e?.code === "offline" ? "offline" : e?.status === 403 ? "permission" : "error");
      setError(e?.message ?? "Não foi possível carregar a fila de jobs.");
    }
  }, [cursor, state, type]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    type ? params.set("type", type) : params.delete("type");
    state ? params.set("state", state) : params.delete("state");
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams, state, type]);
  async function retry() {
    if (!selected || !reason.trim() || !code.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const stepUp = await authenticatedAdminAdapter.completeStepUp(stepUpMethod, code.trim());
      await authenticatedAdminAdapter.retryJob(
        selected.id,
        reason.trim(),
        createAdminCommandKey("job-retry"),
        stepUp.data.token,
      );
      setSelected(null);
      setReason("");
      setCode("");
      setStepUpMethod("totp");
      setFeedback("Retry solicitado. O job voltou para a fila.");
      await load();
    } catch (caught) {
      setFeedback(
        caught instanceof AdminAdapterError ? caught.message : "Não foi possível reexecutar o job.",
      );
    } finally {
      setBusy(false);
    }
  }
  const healthItems = health ? states.map((item) => [item, health[item]] as const) : [];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Saúde de jobs</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Importações e recorrências, com IDs de correlação e sem payload de conteúdo.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>Use os filtros para encontrar falhas operacionais.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label htmlFor="job-type" className="flex-1 text-sm font-medium">
            Tipo
            <select
              id="job-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as AdminJobType | "");
                setCursor(undefined);
              }}
              className="mt-1 h-9 w-full rounded-lg border bg-background px-2"
            >
              <option value="">Todos</option>
              <option value="data.import">Importação</option>
              <option value="recurrence.expand">Recorrência</option>
            </select>
          </label>
          <label htmlFor="job-state" className="flex-1 text-sm font-medium">
            Estado
            <select
              id="job-state"
              value={state}
              onChange={(e) => {
                setState(e.target.value as AdminJobState | "");
                setCursor(undefined);
              }}
              className="mt-1 h-9 w-full rounded-lg border bg-background px-2"
            >
              <option value="">Todos</option>
              {states.map((item) => (
                <option key={item} value={item}>
                  {stateLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden="true" />
            Atualizar
          </Button>
        </CardContent>
      </Card>
      {feedback ? (
        <p role="status" className="rounded-lg border border-border bg-background p-3 text-sm">
          {feedback}
        </p>
      ) : null}
      {status === "success" && health ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {healthItems.map(([item, count]) => (
            <Card key={item} size="sm">
              <CardContent className="pt-3">
                <p className="text-xs text-muted-foreground">{stateLabels[item]}</p>
                <p className="text-xl font-semibold">{count}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
      <AsyncState
        status={status}
        title={status === "empty" ? "Nenhum job encontrado" : undefined}
        description={
          status === "empty" ? "Tente remover um filtro ou volte mais tarde." : (error ?? undefined)
        }
        action={
          status === "error" || status === "offline"
            ? { label: "Tentar novamente", onClick: () => void load() }
            : undefined
        }
      >
        <Card>
          <CardHeader>
            <CardTitle>Jobs recentes</CardTitle>
            <CardDescription>O payload permanece fora do console por segurança.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="p-2 font-medium">Tipo</th>
                    <th className="p-2 font-medium">Estado</th>
                    <th className="p-2 font-medium">Atualizado</th>
                    <th className="p-2 font-medium">Tentativas</th>
                    <th className="p-2 font-medium">Correlação</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} className="border-b last:border-0">
                      <td className="p-2">
                        {typeLabels[job.type]}
                        <span className="block text-xs text-muted-foreground">{job.id}</span>
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={
                            job.state === "failed" || job.state === "dead"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {stateLabels[job.state]}
                        </Badge>
                        {job.lastError ? (
                          <span
                            className="mt-1 block max-w-52 truncate text-xs text-destructive"
                            title={job.lastError}
                          >
                            {job.lastError}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2">{formatDate(job.updatedAt)}</td>
                      <td className="p-2">{job.attempts}</td>
                      <td className="p-2 font-mono text-xs">{job.correlationId}</td>
                      <td className="p-2 text-right">
                        {job.retryable && role === "platform_admin" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelected(job);
                              setFeedback(null);
                            }}
                          >
                            <RotateCcwIcon aria-hidden="true" />
                            Reexecutar
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </AsyncState>
      {status === "success" && nextCursor ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => setCursor(nextCursor)}>
            Carregar mais
          </Button>
        </div>
      ) : null}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reexecutar job</DialogTitle>
            <DialogDescription>
              Essa ação é idempotente e exige motivo e um novo desafio de segundo fator. O payload
              não será exibido.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="job-reason">Motivo</FieldLabel>
              <Input
                id="job-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
              <FieldDescription>Obrigatório para auditoria.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="job-step-up-method">Segundo fator</FieldLabel>
              <select
                id="job-step-up-method"
                value={stepUpMethod}
                onChange={(e) => setStepUpMethod(e.target.value as "totp" | "backup_code")}
                className="h-9 w-full rounded-lg border bg-background px-2"
              >
                <option value="totp">Código do autenticador (TOTP)</option>
                <option value="backup_code">Código de recuperação</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="job-code">
                {stepUpMethod === "totp" ? "Código do autenticador" : "Código de recuperação"}
              </FieldLabel>
              <Input
                id="job-code"
                inputMode={stepUpMethod === "totp" ? "numeric" : "text"}
                autoComplete={stepUpMethod === "totp" ? "one-time-code" : "off"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelected(null)}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void retry()}
              disabled={busy || !reason.trim() || !code.trim()}
            >
              {busy ? "Reexecutando…" : "Confirmar retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
