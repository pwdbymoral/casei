import { Badge } from "@/components/ui/badge";

type Status = "success" | "warning" | "danger" | "info" | "neutral" | "offline";

type StatusBadgeProps = {
  status: Status;
  children: string;
};

const variants: Record<Status, "default" | "secondary" | "destructive" | "outline"> = {
  success: "default",
  warning: "secondary",
  danger: "destructive",
  info: "outline",
  neutral: "secondary",
  offline: "outline",
};

const markers: Record<Status, string> = {
  success: "Concluído",
  warning: "Atenção",
  danger: "Erro",
  info: "Informação",
  neutral: "Estado",
  offline: "Offline",
};

export function StatusBadge({ status, children }: StatusBadgeProps) {
  return (
    <Badge variant={variants[status]} aria-label={`${markers[status]}: ${children}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </Badge>
  );
}
