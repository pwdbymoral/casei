import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { UnauthenticatedState } from "@/components/auth/access-state";
import { AppShell, ShellSkeleton } from "@/components/shell/app-shell";
import { fixtureWorkspaceAdapter, unauthenticatedWorkspaceAdapter } from "@/lib/workspaces";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const useFixture = process.env.NODE_ENV !== "production" && process.env.CASEI_UI_FIXTURES === "1";
  const sessionPort = useFixture ? fixtureWorkspaceAdapter : unauthenticatedWorkspaceAdapter;
  let session = null;
  try {
    session = await sessionPort.getSession();
  } catch {
    return <UnauthenticatedState />;
  }
  if (session.workspaces.length === 0) redirect("/onboarding");
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <AppShell adapterMode={useFixture ? "fixture" : "unauthenticated"} initialSession={session}>
        {children}
      </AppShell>
    </Suspense>
  );
}
