import type { ReactNode } from "react";
import { AdminTwoFactorEnrollment } from "@/components/admin/admin-two-factor-enrollment";
import { AdminAccessDeniedState } from "@/components/auth/access-state";
import { AdminShell } from "@/components/shell/admin-shell";
import { authenticatedPlatformAdminSessionPort } from "@/lib/platform-admin-session-server";

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await authenticatedPlatformAdminSessionPort.getSession();
  if (!session || !["platform_admin", "platform_support"].includes(session.role)) {
    return <AdminAccessDeniedState />;
  }
  if (!session.twoFactorEnabled) {
    return <AdminTwoFactorEnrollment />;
  }
  return (
    <AdminShell displayName={session.displayName} platformRole={session.role}>
      {children}
    </AdminShell>
  );
}
