"use client";

import { ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AdminShellProps = { children: ReactNode; displayName: string };

const links = [
  { href: "/admin", label: "Visão geral" },
  { href: "/admin/accounts", label: "Contas" },
  { href: "/admin/jobs", label: "Atividades" },
  { href: "/admin/audit", label: "Auditoria" },
] as const;

export function AdminShell({ children, displayName }: AdminShellProps) {
  const pathname = usePathname();
  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-foreground text-background">
              <ShieldCheckIcon aria-hidden="true" />
            </div>
            <div>
              <p className="text-lg font-semibold tracking-tight">Casei</p>
              <p className="text-xs text-muted-foreground">Console da plataforma</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{displayName}</span>
            <Badge variant="outline">Acesso reforçado</Badge>
          </div>
        </div>
      </header>
      <div className="border-b bg-background">
        <nav
          className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2 sm:px-6 lg:px-10"
          aria-label="Navegação administrativa"
        >
          {links.map((link) => {
            const active =
              link.href === "/admin" ? pathname === link.href : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
          <span className="ml-auto hidden items-center sm:flex">
            <Link href="/app" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Voltar ao espaço
            </Link>
          </span>
        </nav>
      </div>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-10">{children}</main>
    </div>
  );
}
