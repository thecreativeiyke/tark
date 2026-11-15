/**
 * Coarse distance bands for public artisan discovery.
 * Exact (or 0.1 km) distances let a caller trilaterate stored coordinates, so only a band is exposed.
 * The last band is open-ended because the search radius can reach 50 km.
 */
export const DISTANCE_BANDS = ['< 2 km', '2–5 km', '5–10 km', '10+ km'] as const;

export type DistanceBand = (typeof DISTANCE_BANDS)[number];

export function toDistanceBand(km: number): DistanceBand {
  if (!Number.isFinite(km)) return '10+ km'; // fail coarse
  if (km < 2) return '< 2 km';
  if (km < 5) return '2–5 km';
  if (km < 10) return '5–10 km';
  return '10+ km';
}
