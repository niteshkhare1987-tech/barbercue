import {
  ADMIN_ADOPTION_THRESHOLDS,
  type AdminAdoptionCategory,
} from '@barbercue/shared';

/**
 * Pure KPI rules for the Executive Command Center — the single place the definitions in
 * docs/admin-dashboard-2.0/PLAN.md §4 are implemented, so the API, future exports and tests
 * cannot drift apart. No I/O here.
 */

export const ADOPTION_CATEGORIES: readonly AdminAdoptionCategory[] = [
  'RECENTLY_ONBOARDED',
  'NEVER_ACTIVATED',
  'AT_RISK',
  'HIGHLY_ACTIVE',
  'MODERATELY_ACTIVE',
  'LOW_USAGE',
  'DORMANT',
];

const DAY_MS = 86_400_000;

export interface AdoptionInput {
  registeredAt: Date;
  /** Exclusive end of the 30-day window (the instant the "as of" day ends). */
  windowEnd: Date;
  visitsInWindow: number;
  visitsInPreviousWindow: number;
  /** Completed visits ever, up to windowEnd. */
  visitsEver: number;
}

export function classifyAdoption(
  input: AdoptionInput,
  t = ADMIN_ADOPTION_THRESHOLDS,
): AdminAdoptionCategory {
  const ageDays =
    (input.windowEnd.getTime() - input.registeredAt.getTime()) / DAY_MS;
  if (ageDays <= t.recentlyOnboardedDays) return 'RECENTLY_ONBOARDED';
  if (input.visitsEver === 0) return 'NEVER_ACTIVATED';
  if (
    input.visitsInPreviousWindow >= t.atRiskMinBaselineVisits &&
    input.visitsInWindow <=
      input.visitsInPreviousWindow * (1 - t.atRiskDropPercent / 100)
  ) {
    return 'AT_RISK';
  }
  if (input.visitsInWindow >= t.highlyActiveMinVisits) return 'HIGHLY_ACTIVE';
  if (input.visitsInWindow >= t.moderatelyActiveMinVisits)
    return 'MODERATELY_ACTIVE';
  if (input.visitsInWindow >= 1) return 'LOW_USAGE';
  return 'DORMANT';
}

/** Percentage with one decimal; null when there is nothing to divide by (never a fake 0 %). */
export function ratePercent(
  numerator: number,
  denominator: number,
): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export interface AppointmentOutcomes {
  completed: number;
  cancelled: number;
  noShow: number;
}

/** Cancelled ÷ resolved outcomes (completed + cancelled + no-show). Pending/confirmed excluded. */
export function cancellationRate(o: AppointmentOutcomes): number | null {
  return ratePercent(o.cancelled, o.completed + o.cancelled + o.noShow);
}

/** No-show ÷ resolved attendance outcomes (completed + no-show). */
export function noShowRate(o: AppointmentOutcomes): number | null {
  return ratePercent(o.noShow, o.completed + o.noShow);
}

/** Integer paise average; null when no visit had a known value. */
export function averagePaise(totalPaise: number, count: number): number | null {
  return count > 0 ? Math.round(totalPaise / count) : null;
}

/** The equally long range of IST dates immediately before [from, to]. */
export function previousRange(
  from: string,
  to: string,
  addDays: (date: string, days: number) => string,
): { from: string; to: string } {
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS +
    1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}
