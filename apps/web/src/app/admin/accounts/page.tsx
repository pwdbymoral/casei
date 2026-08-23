import { SearchIcon } from "lucide-react";

import { AsyncState } from "@/components/primitives";

export default function AdminAccountsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Contas</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Busque por identificador ou e-mail sem revelar conteúdo doméstico.
        </p>
      </header>
      <div className="flex min-h-12 items-center gap-3 rounded-xl border bg-background px-4 text-muted-foreground">
        <SearchIcon aria-hidden="true" />
        <span className="text-sm">Busca administrativa será conectada ao contrato AUTH-004.</span>
      </div>
      <AsyncState
        status="empty"
        title="Nenhuma busca executada"
        description="Os resultados aparecerão aqui depois que uma busca autorizada for enviada."
      />
    </div>
  );
}
