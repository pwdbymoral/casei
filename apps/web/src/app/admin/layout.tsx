import type { ReactNode } from "react";

import { AdminAccessDeniedState } from "@/components/auth/access-state";
import { AdminShell } from "@/components/shell/admin-shell";
import { unauthenticatedPlatformAdminSessionPort } from "@/lib/workspaces";

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await unauthenticatedPlatformAdminSessionPort.getSession();
  if (session?.role !== "platform_admin") return <AdminAccessDeniedState />;
  return <AdminShell displayName={session.displayName}>{children}</AdminShell>;
}
