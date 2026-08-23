"use client";

import { useRouter } from "next/navigation";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import type { OnboardingDraft } from "@/lib/onboarding";

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_CASEI_API_ORIGIN ?? "http://localhost:3001").replace(/\/$/, "");
}

export default function OnboardingPage() {
  const router = useRouter();
  return (
    <main className="min-h-dvh bg-muted/30 px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto mb-8 flex max-w-xl items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">Casei</span>
        <span className="text-xs text-muted-foreground">Seu espaço compartilhado</span>
      </div>
      <OnboardingFlow
        onComplete={async (draft: OnboardingDraft) => {
          const response = await fetch(`${apiOrigin()}/v1/onboarding`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `onboarding-${crypto.randomUUID()}`,
            },
            body: JSON.stringify(draft),
          });
          if (response.status === 401) {
            throw new Error("Entre para criar seu espaço e salvar este onboarding.");
          }
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new Error(body?.error?.message ?? "Não foi possível criar o espaço.");
          }
          router.replace("/app");
        }}
      />
    </main>
  );
}
