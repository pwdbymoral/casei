import { AsyncState } from "@/components/primitives";

export default function AdminAuditPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Auditoria</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ações administrativas, ator, motivo e correlation ID.
        </p>
      </header>
      <AsyncState
        status="empty"
        title="Nenhum evento neste período"
        description="A auditoria será consultada com filtros e paginação do contrato administrativo."
      />
    </div>
  );
}
