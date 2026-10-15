import { config } from '../config';

/** Tax on an amount in cents, rounded to the nearest cent. */
export function taxFor(amountCents: number): number {
  return Math.round(amountCents * config.taxRate);
}
