export const SUPPORTED_CURRENCIES = ['NGN', 'USD', 'GHS', 'ZAR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = 'NGN';

export const CURRENCY_DECIMALS: Record<SupportedCurrency, number> = {
  NGN: 2,
  USD: 2,
  GHS: 2,
  ZAR: 2,
};

/**
 * Normalizes a currency code string (trims, uppercases).
 * Returns the matched SupportedCurrency, or DEFAULT_CURRENCY ('NGN') as fallback.
 */
export function normalizeCurrency(currency?: string | null): SupportedCurrency {
  if (!currency || typeof currency !== 'string') {
    return DEFAULT_CURRENCY;
  }
  const code = currency.trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.includes(code as SupportedCurrency)) {
    return code as SupportedCurrency;
  }
  return DEFAULT_CURRENCY;
}

/**
 * Checks whether the given string is a supported currency.
 */
export function isSupportedCurrency(currency?: string | null): currency is SupportedCurrency {
  if (!currency || typeof currency !== 'string') {
    return false;
  }
  return SUPPORTED_CURRENCIES.includes(currency.trim().toUpperCase() as SupportedCurrency);
}

/**
 * Converts a major currency unit (e.g., Naira, Dollars, Cedis, Rand)
 * into its standard integer minor unit (Kobo, Cents, Pesewas).
 * All 4 supported currencies use standard 2-decimal (10^2) division.
 */
export function toMinorUnits(amount: number | string, currency: string = DEFAULT_CURRENCY): number {
  const norm = normalizeCurrency(currency);
  const factor = Math.pow(10, CURRENCY_DECIMALS[norm] ?? 2);
  const val = typeof amount === 'number' ? amount : parseFloat(amount);
  if (isNaN(val)) return 0;
  return Math.round(val * factor);
}

/**
 * Converts standard integer minor units back into a major currency unit.
 */
export function fromMinorUnits(amountMinor: number, currency: string = DEFAULT_CURRENCY): number {
  const norm = normalizeCurrency(currency);
  const factor = Math.pow(10, CURRENCY_DECIMALS[norm] ?? 2);
  if (isNaN(amountMinor)) return 0;
  return amountMinor / factor;
}
