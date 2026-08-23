import { ActivityIcon, UsersIcon } from "lucide-react";

import { StatusBadge } from "@/components/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-muted-foreground">Administração da plataforma</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Operação sem entrar em espaços
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Este console mostra somente metadados de operação. Conteúdo financeiro e doméstico não
          aparece aqui.
        </p>
      </header>
      <Alert>
        <ActivityIcon aria-hidden="true" />
        <AlertTitle>Acesso administrativo separado</AlertTitle>
        <AlertDescription>
          Ações críticas exigem autenticação recente, segundo fator e motivo. A sessão
          administrativa não concede acesso a um espaço.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <UsersIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Contas</CardTitle>
            <CardDescription>
              Busca por ID ou e-mail normalizado, com metadados mínimos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="info">Nenhuma busca executada</StatusBadge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <ActivityIcon aria-hidden="true" className="mb-2" />
            <CardTitle>Atividades</CardTitle>
            <CardDescription>Saúde de jobs e auditoria administrativa.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusBadge status="success">Operação estável</StatusBadge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
