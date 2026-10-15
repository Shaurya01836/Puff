import { beforeEach, describe, expect, it } from 'vitest';
import { addItem, getCart } from '../src/cart/cart';
import { logEntries } from '../src/lib/logger';
import { getOrder, placeOrder } from '../src/orders/orders';
import { resetAll } from './helpers';

beforeEach(resetAll);

describe('orders', () => {
  it('charges the cart total, clears the cart and audits the order', () => {
    addItem('usr_1', 'p_mug', 1);
    const order = placeOrder('usr_1', 'tok_visa');
    expect(order.totalCents).toBe(1769); // 1499 + 18% tax
    expect(getCart('usr_1').lines).toHaveLength(0);
    expect(getOrder('usr_1', order.id).id).toBe(order.id);
    expect(logEntries().some((e) => e.message === 'audit:order.placed')).toBe(true);
  });

  it('keeps the cart when the card is declined', () => {
    addItem('usr_1', 'p_mug', 1);
    expect(() => placeOrder('usr_1', 'tok_declined')).toThrow(/declined/);
    expect(getCart('usr_1').lines).toHaveLength(1);
  });

  it('refuses an empty cart', () => {
    expect(() => placeOrder('usr_1', 'tok_visa')).toThrow(/empty/);
  });

  it("does not show another user's order", () => {
    addItem('usr_1', 'p_mug', 1);
    const order = placeOrder('usr_1', 'tok_visa');
    expect(() => getOrder('usr_2', order.id)).toThrow(/not found/);
  });
});
