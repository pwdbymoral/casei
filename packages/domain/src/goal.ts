import { DomainError } from "./errors.js";
import { parseLocalDate } from "./time.js";

export type GoalStatus = "active" | "completed" | "paused" | "canceled";

export interface GoalReservationTotals {
  allocatedMinor: bigint;
  releasedMinor: bigint;
  spentMinor: bigint;
}

/** Number of monthly contribution windows from today through a future deadline. */
export function goalContributionPeriods(today: string, deadline: string | null): number | null {
  if (deadline === null) return null;
  const parsedToday = parseLocalDate(today);
  const parsedDeadline = parseLocalDate(deadline);
  if (!parsedToday.ok || !parsedDeadline.ok) {
    throw new DomainError("invalid_local_date", "O prazo da meta deve ser uma data civil válida.");
  }
  if (deadline < today) return 0;
  const [todayYear = 0, todayMonth = 0, todayDay = 0] = today.split("-").map(Number);
  const [deadlineYear = 0, deadlineMonth = 0, deadlineDay = 0] = deadline.split("-").map(Number);
  let periods = (deadlineYear - todayYear) * 12 + (deadlineMonth - todayMonth);
  if (deadlineDay < todayDay) periods -= 1;
  return Math.max(1, periods);
}

/** The virtual reserve is reconstructed from its append-only movement totals. */
export function calculateGoalReservation({
  allocatedMinor,
  releasedMinor,
  spentMinor,
}: GoalReservationTotals): bigint {
  assertNonNegative(allocatedMinor, "A alocação da meta não pode ser negativa.");
  assertNonNegative(releasedMinor, "A liberação da meta não pode ser negativa.");
  assertNonNegative(spentMinor, "O gasto da meta não pode ser negativo.");
  const reservedMinor = allocatedMinor - releasedMinor - spentMinor;
  if (reservedMinor < 0n) {
    throw new DomainError("validation_failed", "A reserva da meta não pode ficar negativa.");
  }
  return reservedMinor;
}

export function calculateGoalCoverage(
  reservedMinor: bigint,
  walletBalanceMinor: bigint,
): { coveredMinor: bigint; uncoveredMinor: bigint } {
  assertNonNegative(reservedMinor, "A reserva da meta não pode ser negativa.");
  const availableMinor = walletBalanceMinor > 0n ? walletBalanceMinor : 0n;
  const coveredMinor = reservedMinor < availableMinor ? reservedMinor : availableMinor;
  return {
    coveredMinor: coveredMinor > 0n ? coveredMinor : 0n,
    uncoveredMinor: reservedMinor > availableMinor ? reservedMinor - availableMinor : 0n,
  };
}

export function goalAllocation(input: {
  reservedMinor: bigint;
  walletBalanceMinor: bigint;
  amountMinor: bigint;
  allowUncovered: boolean;
}): { reservedMinor: bigint; uncoveredMinor: bigint } {
  assertPositive(input.amountMinor, "O valor reservado deve ser positivo.");
  const nextReservedMinor = input.reservedMinor + input.amountMinor;
  const coverage = calculateGoalCoverage(nextReservedMinor, input.walletBalanceMinor);
  if (coverage.uncoveredMinor > 0n && !input.allowUncovered) {
    throw new DomainError(
      "validation_failed",
      "A reserva excede o saldo disponível; confirme para continuar sem cobertura.",
    );
  }
  return { reservedMinor: nextReservedMinor, uncoveredMinor: coverage.uncoveredMinor };
}

export function goalStatusAfterReservation(input: {
  status: GoalStatus;
  targetMinor: bigint;
  reservedMinor: bigint;
}): GoalStatus {
  if (input.status === "paused" || input.status === "canceled") return input.status;
  if (input.reservedMinor >= input.targetMinor) return "completed";
  return "active";
}

function assertNonNegative(value: bigint, message: string): void {
  if (value < 0n) throw new DomainError("validation_failed", message);
}

function assertPositive(value: bigint, message: string): void {
  if (value <= 0n) throw new DomainError("validation_failed", message);
}
