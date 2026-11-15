import { BadRequestException } from '@nestjs/common';

export const COARSE_LOCATION_FALLBACK = 'Exact location shared after assignment';

export enum BudgetTier {
  MICRO = 'MICRO',
  STANDARD = 'STANDARD',
  MAJOR = 'MAJOR',
  CUSTOM_QUOTE = 'CUSTOM_QUOTE',
}

// Thresholds are in the job's own major currency unit and are never sent to clients.
const MICRO_MAX = 50_000;
const STANDARD_MAX = 500_000;

export function toBudgetTier(budget: unknown): BudgetTier {
  const amount = Number(budget);
  if (!Number.isFinite(amount) || amount <= 0) return BudgetTier.CUSTOM_QUOTE;
  if (amount < MICRO_MAX) return BudgetTier.MICRO;
  if (amount < STANDARD_MAX) return BudgetTier.STANDARD;
  return BudgetTier.MAJOR;
}

/** Lowercase ascii slug, e.g. "Ìbàdàn North" -> "ibadan-north". Returns null when nothing usable remains. */
export function normalizeAreaCode(input?: string | null): string | null {
  if (!input) return null;
  const code = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return code || null;
}

/**
 * Jobs store "street, area, city". The area code is the LAST comma segment (city level),
 * so admins should set artisan areaCodes at the same granularity. No comma => unknown.
 */
export function deriveAreaCodeFromLocation(location?: string | null): string | null {
  if (!location || !location.includes(',')) return null;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? normalizeAreaCode(parts[parts.length - 1]) : null;
}

/** Fail closed: never reveals the street. */
export function coarseLocation(location?: string | null): string {
  if (!location || !location.includes(',')) return COARSE_LOCATION_FALLBACK;
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return COARSE_LOCATION_FALLBACK;
  return parts.length >= 3 ? parts.slice(-2).join(', ') : parts[parts.length - 1];
}

export function truncate(text: string | null | undefined, max: number): string {
  const chars = Array.from((text ?? '').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** Escapes LIKE wildcards; pair with `ESCAPE '\'` in the query. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// ── Opaque keyset cursor over (createdAt DESC, id DESC) ──
// `ts` is Postgres' own text rendering of createdAt (keeps microseconds; JS Dates would not).
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobCursor {
  ts: string;
  id: string;
}

export function encodeCursor(cursor: JobCursor): string {
  return Buffer.from(JSON.stringify([cursor.ts, cursor.id])).toString('base64url');
}

export function decodeCursor(raw: string): JobCursor {
  try {
    const [ts, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof ts === 'string' &&
      typeof id === 'string' &&
      CURSOR_TS.test(ts) &&
      UUID_RE.test(id)
    ) {
      return { ts, id };
    }
  } catch {
    // fall through
  }
  throw new BadRequestException('Invalid cursor');
}
