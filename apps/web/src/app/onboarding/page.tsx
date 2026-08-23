"use client";

import { useRouter } from "next/navigation";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export default function OnboardingPage() {
  const router = useRouter();
  return (
    <main className="min-h-dvh bg-muted/30 px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto mb-8 flex max-w-xl items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">Casei</span>
        <span className="text-xs text-muted-foreground">Seu espaço compartilhado</span>
      </div>
      <OnboardingFlow
        onComplete={async () => {
          router.push("/app");
        }}
      />
    </main>
  );
}
