export const domainErrorCodes = [
  "validation_failed",
  "invalid_id",
  "invalid_user_id",
  "invalid_correlation_id",
  "invalid_money",
  "money_out_of_range",
  "currency_mismatch",
  "invalid_allocation",
  "invalid_local_date",
  "invalid_time_zone",
  "invalid_instant",
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/**
 * Erro seguro para atravessar a camada de domínio sem vazar stack, SQL ou
 * dados de entrada. A API é responsável por adicionar correlationId e por
 * mapear o código para status HTTP.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly fieldErrors?: FieldErrors;

  constructor(code: DomainErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  toJSON(): {
    code: DomainErrorCode;
    message: string;
    fieldErrors?: FieldErrors;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors === undefined ? {} : { fieldErrors: this.fieldErrors }),
    };
  }
}

export function validationError(
  message = "Revise os campos indicados.",
  fieldErrors?: FieldErrors,
): DomainError {
  return new DomainError("validation_failed", message, fieldErrors);
}
