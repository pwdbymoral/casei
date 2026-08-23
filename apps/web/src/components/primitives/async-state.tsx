import { AlertCircleIcon, CloudOffIcon, LockKeyholeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export type AsyncStateStatus = "loading" | "success" | "empty" | "error" | "offline" | "permission";

type AsyncStateProps = {
  status: AsyncStateStatus;
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
};

export function AsyncState({ status, title, description, action, children }: AsyncStateProps) {
  if (status === "success") return children;

  if (status === "loading") {
    return (
      <div role="status" className="flex flex-col gap-4" aria-busy="true" aria-label="Carregando">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{title ? "✦" : "—"}</EmptyMedia>
          <EmptyTitle>{title ?? "Nada por aqui ainda"}</EmptyTitle>
          <EmptyDescription>
            {description ?? "Quando houver dados, eles aparecem nesta área."}
          </EmptyDescription>
        </EmptyHeader>
        {action ? (
          <Button onClick={action.onClick} type="button">
            {action.label}
          </Button>
        ) : null}
      </Empty>
    );
  }

  const isOffline = status === "offline";
  const isPermission = status === "permission";
  const Icon = isOffline ? CloudOffIcon : isPermission ? LockKeyholeIcon : AlertCircleIcon;

  return (
    <Alert variant={isPermission ? "default" : "destructive"}>
      <Icon aria-hidden="true" />
      <AlertTitle>
        {title ??
          (isOffline
            ? "Você está offline"
            : isPermission
              ? "Acesso não disponível"
              : "Não foi possível carregar")}
      </AlertTitle>
      <AlertDescription>
        {description ??
          (isOffline
            ? "Mostramos apenas o que estava disponível no cache. Conecte-se para fazer alterações."
            : isPermission
              ? "Este espaço não está disponível para sua permissão atual."
              : "Tente novamente. Seus dados preenchidos permanecem neste dispositivo.")}
      </AlertDescription>
      {action ? (
        <Button className="mt-3" onClick={action.onClick} type="button" variant="outline">
          {action.label}
        </Button>
      ) : null}
    </Alert>
  );
}
