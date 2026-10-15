import { paymentRequired } from '../lib/errors';
import { newId } from '../lib/ids';

export interface Charge {
  id: string;
  amountCents: number;
}

/** Fake card processor that accepts test tokens only. `tok_declined` is always declined. */
export function chargeCard(cardToken: string, amountCents: number): Charge {
  if (!cardToken.startsWith('tok_')) throw paymentRequired('Invalid card token');
  if (cardToken === 'tok_declined') throw paymentRequired('Card declined');
  return { id: newId('ch'), amountCents };
}
