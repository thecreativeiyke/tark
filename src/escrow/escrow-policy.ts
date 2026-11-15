// Single source of truth for the Safe-Lock tranche policy (ADR 001).
//
// Bounds are read lazily (at call time, not import time) so values from .env are
// already loaded by ConfigModule. All comparisons are done in integer minor units
// (kobo) so there is no floating-point slop at the exact boundaries.

import { toMinorUnits } from '../common/currency';
export { toMinorUnits };

export function tranche1Bounds(): { min: number; max: number } {
  const rawMin = Number(process.env.TRANCHE1_MIN_PCT ?? 30);
  const rawMax = Number(process.env.TRANCHE1_MAX_PCT ?? 50);
  const min = Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 100 ? rawMin : 30;
  const max = Number.isFinite(rawMax) && rawMax >= min && rawMax <= 100 ? rawMax : 50;
  return { min, max };
}



/** True when Tranche 1 is within the allowed share of the total (inclusive bounds). */
export function isTranche1Compliant(tranche1Minor: number, totalMinor: number): boolean {
  if (
    !Number.isSafeInteger(tranche1Minor) ||
    !Number.isSafeInteger(totalMinor) ||
    totalMinor <= 0 ||
    tranche1Minor < 0
  ) {
    return false;
  }
  const { min, max } = tranche1Bounds();
  return tranche1Minor * 100 >= totalMinor * min && tranche1Minor * 100 <= totalMinor * max;
}

export function tranche1PolicyMessage(): string {
  const { min, max } = tranche1Bounds();
  return `Start-Work Mobilization (Tranche 1) must be between ${min}% and ${max}% of the total amount.`;
}
