"use client";

import { useEffect, useRef, useState } from "react";
import { AsyncState, MoneyInput } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type OnboardingDraft = {
  displayName: string;
  workspaceName: string;
  currency: "BRL";
  timeZone: string;
  initialBalanceMinor: string;
  includeInitialBalance: boolean;
};

type OnboardingFlowProps = {
  onComplete?: (draft: OnboardingDraft) => Promise<void>;
};

const draftStorageKey = "casei:onboarding-draft:v1";
const defaultTimeZone = "America/Fortaleza";
const timeZoneOptions = [
  "America/Fortaleza",
  "America/Sao_Paulo",
  "America/Recife",
  "America/Manaus",
];

const emptyDraft: OnboardingDraft = {
  displayName: "",
  workspaceName: "",
  currency: "BRL",
  timeZone: defaultTimeZone,
  initialBalanceMinor: "0",
  includeInitialBalance: false,
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

function loadDraft(): OnboardingDraft {
  if (typeof window === "undefined") return emptyDraft;
  try {
    const saved = window.localStorage.getItem(draftStorageKey);
    if (!saved) return emptyDraft;
    const parsed = JSON.parse(saved) as Partial<OnboardingDraft>;
    return { ...emptyDraft, ...parsed, currency: "BRL" };
  } catch {
    return emptyDraft;
  }
}

function saveDraft(draft: OnboardingDraft): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
  }
}

function clearDraft(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(draftStorageKey);
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(emptyDraft);
  const [step, setStep] = useState<OnboardingStep>(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = loadDraft();
    setDraft(saved);
    if (saved.workspaceName) setStep(3);
    else if (saved.displayName) setStep(2);
  }, []);

  // step intentionally triggers focus after each progressive-disclosure transition.
  // biome-ignore lint/correctness/useExhaustiveDependencies: step is the focus transition trigger
  useEffect(() => {
    if (!done) firstFieldRef.current?.focus();
  }, [step, done]);

  function updateDraft(patch: Partial<OnboardingDraft>) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      saveDraft(next);
      return next;
    });
    setErrors({});
    setSubmitError(null);
  }

  function nextStep() {
    const nextErrors = validateOnboardingStep(step, draft);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setStep((current) => (current === 3 ? 3 : ((current + 1) as OnboardingStep)));
  }

  async function finish() {
    const nextErrors = validateOnboardingStep(3, draft);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onComplete?.(draft);
      clearDraft();
      setDone(true);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Não foi possível criar o espaço.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AsyncState
        status="success"
        title="Seu espaço está pronto"
        description="Agora você pode começar pelo saldo, por uma transação ou pela lista de compras."
      >
        <div className="rounded-2xl border bg-background p-6 text-center shadow-sm">
          <h2 className="text-xl font-semibold">Seu espaço está pronto</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Agora você pode começar pelo saldo, por uma transação ou pela lista de compras.
          </p>
        </div>
      </AsyncState>
    );
  }

  const stepTitles = ["Como chamar você", "Seu espaço", "Comece com contexto"];
  const currentError = Object.values(errors)[0];

  return (
    <section className="mx-auto w-full max-w-xl" aria-labelledby="onboarding-title">
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">Passo {step} de 3</p>
        <section className="mt-3 grid grid-cols-3 gap-2" aria-label={`Etapa ${step} de 3`}>
          {stepTitles.map((title, index) => {
            const itemStep = (index + 1) as OnboardingStep;
            return (
              <div key={title} className="flex flex-col gap-2">
                <div
                  className={cn("h-1.5 rounded-full", itemStep <= step ? "bg-primary" : "bg-muted")}
                />
                <span
                  className={cn(
                    "text-xs",
                    itemStep === step ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {title}
                </span>
              </div>
            );
          })}
        </section>
      </div>

      <div className="rounded-2xl border bg-background p-5 shadow-sm sm:p-8">
        <h1 id="onboarding-title" className="text-2xl font-semibold tracking-tight">
          {stepTitles[step - 1]}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {step === 1
            ? "Um nome torna o espaço mais acolhedor para quem compartilha com você."
            : step === 2
              ? "O nome aparece para todas as pessoas autorizadas."
              : "Você pode pular o saldo e adicionar depois, sem bloquear o começo."}
        </p>

        {currentError ? (
          <div
            className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
            tabIndex={-1}
          >
            Revise o campo indicado: {currentError}
          </div>
        ) : null}
        {submitError ? (
          <div className="mt-5">
            <AsyncState status="error" description={submitError} />
          </div>
        ) : null}

        <div className="mt-7">
          {step === 1 ? (
            <FieldGroup>
              <Field data-invalid={Boolean(errors.displayName)}>
                <FieldLabel htmlFor="display-name">Nome de exibição</FieldLabel>
                <Input
                  ref={firstFieldRef}
                  id="display-name"
                  name="displayName"
                  autoComplete="name"
                  value={draft.displayName}
                  onChange={(event) => updateDraft({ displayName: event.target.value })}
                  aria-invalid={Boolean(errors.displayName)}
                  aria-describedby={
                    errors.displayName ? "display-name-error" : "display-name-description"
                  }
                />
                <FieldDescription id="display-name-description">
                  Você poderá mudar isso depois em seu perfil.
                </FieldDescription>
                {errors.displayName ? (
                  <FieldError id="display-name-error">{errors.displayName}</FieldError>
                ) : null}
              </Field>
            </FieldGroup>
          ) : null}

          {step === 2 ? (
            <FieldGroup>
              <Field data-invalid={Boolean(errors.workspaceName)}>
                <FieldLabel htmlFor="workspace-name">Nome do espaço</FieldLabel>
                <Input
                  ref={firstFieldRef}
                  id="workspace-name"
                  name="workspaceName"
                  autoComplete="organization"
                  value={draft.workspaceName}
                  onChange={(event) => updateDraft({ workspaceName: event.target.value })}
                  aria-invalid={Boolean(errors.workspaceName)}
                  aria-describedby={
                    errors.workspaceName ? "workspace-name-error" : "workspace-name-description"
                  }
                />
                <FieldDescription id="workspace-name-description">
                  Ex.: Casa Horizonte, Nossa casa ou Família.
                </FieldDescription>
                {errors.workspaceName ? (
                  <FieldError id="workspace-name-error">{errors.workspaceName}</FieldError>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="time-zone">Fuso horário</FieldLabel>
                <select
                  id="time-zone"
                  name="timeZone"
                  className="min-h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  value={draft.timeZone}
                  onChange={(event) => updateDraft({ timeZone: event.target.value })}
                >
                  {timeZoneOptions.map((timeZone) => (
                    <option key={timeZone} value={timeZone}>
                      {timeZone.replace("America/", "")}
                    </option>
                  ))}
                </select>
                <FieldDescription>Datas da casa seguem este fuso.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="currency">Moeda</FieldLabel>
                <Input
                  id="currency"
                  name="currency"
                  value="BRL — Real brasileiro"
                  readOnly
                  aria-describedby="currency-description"
                />
                <FieldDescription id="currency-description">
                  BRL é a moeda inicial do Casei.
                </FieldDescription>
              </Field>
            </FieldGroup>
          ) : null}

          {step === 3 ? (
            <FieldSet>
              <FieldLegend>Saldo inicial (opcional)</FieldLegend>
              <FieldDescription>
                Se você não souber agora, pule. As projeções ficam com confiança baixa até haver
                mais dados.
              </FieldDescription>
              <FieldGroup className="mt-4">
                <Field>
                  <label
                    className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                    htmlFor="include-initial-balance"
                  >
                    <input
                      id="include-initial-balance"
                      type="checkbox"
                      checked={draft.includeInitialBalance}
                      onChange={(event) =>
                        updateDraft({ includeInitialBalance: event.target.checked })
                      }
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span>
                      <strong className="font-medium">Informar saldo agora</strong>
                      <span className="mt-0.5 block text-muted-foreground">
                        Isso ajuda a mostrar o que está disponível desde o começo.
                      </span>
                    </span>
                  </label>
                </Field>
                {draft.includeInitialBalance ? (
                  <MoneyInput
                    id="initial-balance"
                    value={draft.initialBalanceMinor}
                    onChange={(initialBalanceMinor) => updateDraft({ initialBalanceMinor })}
                    error={errors.initialBalanceMinor}
                  />
                ) : null}
              </FieldGroup>
            </FieldSet>
          ) : null}
        </div>

        <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          {step > 1 ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setStep((current) => (current - 1) as OnboardingStep);
                setErrors({});
              }}
            >
              Voltar
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button type="button" onClick={nextStep}>
              Continuar
            </Button>
          ) : (
            <Button type="button" onClick={() => void finish()} disabled={submitting}>
              {submitting ? "Criando espaço…" : "Criar meu espaço"}
            </Button>
          )}
        </div>
        <p className="mt-5 text-center text-xs text-muted-foreground">
          Seu rascunho é salvo neste dispositivo até concluir ou limpar o fluxo.
        </p>
      </div>
    </section>
  );
}
