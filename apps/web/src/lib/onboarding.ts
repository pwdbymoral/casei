export type OnboardingDraft = {
  displayName: string;
  workspaceName: string;
  currency: "BRL";
  timeZone: string;
  initialBalanceMinor: string;
  includeInitialBalance: boolean;
};

export type OnboardingStep = 1 | 2 | 3;

export function validateOnboardingStep(
  step: OnboardingStep,
  draft: OnboardingDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 1 && draft.displayName.trim().length < 2) {
    errors.displayName = "Digite como você gostaria de ser chamado(a).";
  }
  if (step === 2 && draft.workspaceName.trim().length < 2) {
    errors.workspaceName = "Dê um nome curto para o espaço compartilhado.";
  }
  if (
    step === 3 &&
    draft.includeInitialBalance &&
    BigInt(draft.initialBalanceMinor || "0") < BigInt(0)
  ) {
    errors.initialBalanceMinor = "O saldo inicial não pode ser negativo nesta etapa.";
  }
  return errors;
}
