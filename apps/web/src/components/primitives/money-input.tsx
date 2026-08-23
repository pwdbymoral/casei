"use client";

import { useId } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatMoneyMinor, parseMoneyInput } from "@/lib/money";

type MoneyInputProps = {
  value: string;
  onChange: (minor: string) => void;
  label?: string;
  description?: string;
  error?: string;
  currency?: string;
  locale?: string;
  id?: string;
  disabled?: boolean;
  autoFocus?: boolean;
};

export function MoneyInput({
  value,
  onChange,
  label = "Valor",
  description = "Digite o valor em reais. Os centavos são preservados.",
  error,
  currency = "BRL",
  locale = "pt-BR",
  id: providedId,
  disabled,
  autoFocus,
}: MoneyInputProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  return (
    <Field data-invalid={Boolean(error)} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={formatMoneyMinor(value, currency, locale)}
        onChange={(event) => onChange(parseMoneyInput(event.target.value))}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : descriptionId}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
    </Field>
  );
}
