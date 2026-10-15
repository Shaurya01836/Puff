import { badRequest } from '../lib/errors';

interface Discount {
  code: string;
  percentOff: number;
}

const DISCOUNTS: Discount[] = [
  { code: 'WELCOME10', percentOff: 10 },
  { code: 'PUFF25', percentOff: 25 },
];

export function findDiscount(code: string): Discount {
  const discount = DISCOUNTS.find((d) => d.code === code.toUpperCase());
  if (!discount) throw badRequest(`Unknown discount code ${code}`);
  return discount;
}

/** Discount amount in cents for a subtotal. Applied before tax. */
export function applyDiscount(subtotalCents: number, code: string | undefined): number {
  if (!code) return 0;
  return Math.round((subtotalCents * findDiscount(code).percentOff) / 100);
}
