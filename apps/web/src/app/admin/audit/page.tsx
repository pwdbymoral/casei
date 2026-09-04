"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AsyncState } from "@/components/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AdminAdapterError, type AdminAuditEvent, authenticatedAdminAdapter } from "@/lib/admin";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default function AdminAuditPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "loading" | "success" | "empty" | "error" | "offline" | "permission"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [actorId, setActorId] = useState(() => searchParams.get("actorId") ?? "");
  const [targetId, setTargetId] = useState(() => searchParams.get("targetId") ?? "");
  const [action, setAction] = useState(() => searchParams.get("action") ?? "");
  const [from, setFrom] = useState(() => searchParams.get("from") ?? "");
  const [to, setTo] = useState(() => searchParams.get("to") ?? "");
  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await authenticatedAdminAdapter.searchAudit({
        actorId: actorId.trim() || undefined,
        targetId: targetId.trim() || undefined,
        action: action.trim() || undefined,
        from: from ? new Date(`${from}T00:00:00.000Z`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999Z`).toISOString() : undefined,
        cursor,
      });
      setEvents((current) => (cursor ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.page.hasMore ? result.data.page.nextCursor : null);
      setStatus(cursor || result.data.items.length ? "success" : "empty");
    } catch (caught) {
      const e = caught instanceof AdminAdapterError ? caught : null;
      setStatus(e?.code === "offline" ? "offline" : e?.status === 403 ? "permission" : "error");
      setError(e?.message ?? "Não foi possível carregar a auditoria.");
    }
  }, [action, actorId, cursor, from, targetId, to]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    const filters = { actorId, targetId, action, from, to };
    for (const [key, value] of Object.entries(filters))
      value ? params.set(key, value) : params.delete(key);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [action, actorId, from, router, searchParams, targetId, to]);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Auditoria administrativa</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Eventos dos últimos 365 dias, filtráveis por ator, alvo, ação e período. Motivos e
          correlações não incluem conteúdo doméstico.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>
            Períodos usam o UTC do servidor. Deixe em branco para consultar a retenção vigente.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label htmlFor="audit-actor" className="text-sm font-medium">
            Ator (ID)
            <Input
              id="audit-actor"
              className="mt-1"
              value={actorId}
              onChange={(e) => {
                setActorId(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <label htmlFor="audit-target" className="text-sm font-medium">
            Alvo (ID)
            <Input
              id="audit-target"
              className="mt-1"
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <label htmlFor="audit-action" className="text-sm font-medium">
            Ação
            <Input
              id="audit-action"
              className="mt-1"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setCursor(undefined);
              }}
              placeholder="job:retry"
            />
          </label>
          <label htmlFor="audit-from" className="text-sm font-medium">
            A partir de
            <Input
              id="audit-from"
              className="mt-1"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <label htmlFor="audit-to" className="text-sm font-medium">
            Até
            <Input
              id="audit-to"
              className="mt-1"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <div className="flex items-end">
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCwIcon aria-hidden="true" />
              Atualizar
            </Button>
          </div>
        </CardContent>
      </Card>
      <AsyncState
        status={status}
        title={status === "empty" ? "Nenhum evento neste período" : undefined}
        description={
          status === "empty"
            ? "Ajuste os filtros ou aguarde novas ações administrativas."
            : (error ?? undefined)
        }
        action={
          status === "error" || status === "offline"
            ? { label: "Tentar novamente", onClick: () => void load() }
            : undefined
        }
      >
        <Card>
          <CardHeader>
            <CardTitle>Eventos</CardTitle>
            <CardDescription>
              Cada evento possui uma correlação para investigação operacional.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="p-2 font-medium">Quando</th>
                    <th className="p-2 font-medium">Ação</th>
                    <th className="p-2 font-medium">Ator / alvo</th>
                    <th className="p-2 font-medium">Resultado</th>
                    <th className="p-2 font-medium">Motivo</th>
                    <th className="p-2 font-medium">Correlação</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id} className="border-b align-top last:border-0">
                      <td className="p-2 whitespace-nowrap">{formatDate(event.occurredAt)}</td>
                      <td className="p-2 font-mono text-xs">{event.action}</td>
                      <td className="p-2 text-xs">
                        <span className="block">ator: {event.actorId ?? "indisponível"}</span>
                        <span className="block text-muted-foreground">
                          alvo: {event.targetId ?? "indisponível"}
                        </span>
                      </td>
                      <td className="p-2">
                        <Badge variant={event.result === "failure" ? "destructive" : "secondary"}>
                          {event.result === "failure" ? "Falha" : "Sucesso"}
                        </Badge>
                      </td>
                      <td className="max-w-64 p-2 break-words">{event.reason}</td>
                      <td className="p-2 font-mono text-xs">{event.correlationId}</td>
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
    </div>
  );
}
