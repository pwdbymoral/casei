import { AsyncState } from "@/components/primitives";

export default function AdminJobsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Atividades</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Jobs e reexecuções idempotentes, sem dados de conteúdo.
        </p>
      </header>
      <AsyncState
        status="empty"
        title="Nenhum job para revisar"
        description="A fila de operações aparecerá quando a API de administração estiver conectada."
      />
    </div>
  );
}
