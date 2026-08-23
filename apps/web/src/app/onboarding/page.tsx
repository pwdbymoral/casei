"use client";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export default function OnboardingPage() {
  return (
    <main className="min-h-dvh bg-muted/30 px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto mb-8 flex max-w-xl items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">Casei</span>
        <span className="text-xs text-muted-foreground">Seu espaço compartilhado</span>
      </div>
      <OnboardingFlow
        onComplete={async () => {
          // AUTH-002 wires this callback to the idempotent server command. Until
          // then, never present a local-only draft as a successfully created space.
          throw new Error("Entre para criar seu espaço e salvar este onboarding.");
        }}
      />
    </main>
  );
}
