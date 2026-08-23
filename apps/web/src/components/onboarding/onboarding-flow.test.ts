import { describe, expect, it } from "vitest";

import { type OnboardingDraft, validateOnboardingStep } from "./onboarding-flow";

const draft: OnboardingDraft = {
  displayName: "",
  workspaceName: "",
  currency: "BRL",
  timeZone: "America/Fortaleza",
  initialBalanceMinor: "0",
  includeInitialBalance: false,
};

describe("onboarding validation", () => {
  it("requires only the name on the first step", () => {
    expect(validateOnboardingStep(1, draft)).toEqual({
      displayName: "Digite como você gostaria de ser chamado(a).",
    });
    expect(validateOnboardingStep(1, { ...draft, displayName: "Ana" })).toEqual({});
  });

  it("requires a workspace name but keeps currency and timezone explicit", () => {
    expect(validateOnboardingStep(2, { ...draft, displayName: "Ana" })).toEqual({
      workspaceName: "Dê um nome curto para o espaço compartilhado.",
    });
    expect(validateOnboardingStep(2, { ...draft, workspaceName: "Casa" })).toEqual({});
  });

  it("allows skipping the initial balance", () => {
    expect(validateOnboardingStep(3, draft)).toEqual({});
  });
});
