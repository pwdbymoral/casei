"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { caretPositionAfterFormatting, formatMoneyMinor, parseMoneyInput } from "@/lib/money";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [digitsBeforeCaret, setDigitsBeforeCaret] = useState<number | null>(null);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  useLayoutEffect(() => {
    if (digitsBeforeCaret === null || !inputRef.current) return;
    const nextPosition = caretPositionAfterFormatting(inputRef.current.value, digitsBeforeCaret);
    inputRef.current.setSelectionRange(nextPosition, nextPosition);
    setDigitsBeforeCaret(null);
  }, [digitsBeforeCaret]);

  return (
    <Field data-invalid={Boolean(error)} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        ref={inputRef}
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={formatMoneyMinor(value, currency, locale)}
        onChange={(event) => {
          const cursor = event.target.selectionStart ?? event.target.value.length;
          setDigitsBeforeCaret(event.target.value.slice(0, cursor).replace(/\D/g, "").length);
          onChange(parseMoneyInput(event.target.value));
        }}
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
