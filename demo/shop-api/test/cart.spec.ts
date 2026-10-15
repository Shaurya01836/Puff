import { beforeEach, describe, expect, it } from 'vitest';
import { addItem, cartTotal, getCart, removeItem, setDiscount } from '../src/cart/cart';
import { findProduct } from '../src/products/products';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

describe('cart', () => {
  it('adds items and reserves stock', () => {
    addItem('usr_1', 'p_mug', 2);
    addItem('usr_1', 'p_mug', 1);
    expect(getCart('usr_1').lines).toEqual([
      { productId: 'p_mug', name: 'Octopus Mug', unitPriceCents: 1499, quantity: 3 },
    ]);
    expect(findProduct('p_mug').stock).toBe(22);
  });

  it('refuses more than is in stock', () => {
    expect(() => addItem('usr_1', 'p_notebook', 1)).toThrow(/Only 0/);
  });

  it('releases stock when a line is removed', () => {
    addItem('usr_1', 'p_hoodie', 3);
    removeItem('usr_1', 'p_hoodie');
    expect(findProduct('p_hoodie').stock).toBe(8);
    expect(getCart('usr_1').lines).toHaveLength(0);
  });

  it('applies the discount before tax', () => {
    addItem('usr_1', 'p_tee', 2); // 4998
    setDiscount('usr_1', 'welcome10'); // -500
    expect(cartTotal(getCart('usr_1'))).toEqual({
      subtotalCents: 4998,
      discountCents: 500,
      taxCents: 810, // 18% of 4498
      totalCents: 5308,
    });
  });
});

describe('cart routes', () => {
  it('requires a session', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../src/app');
    await request(createApp()).get('/cart').expect(401);
  });

  it('adds an item through the API', async () => {
    const agent = await signedInAgent();
    const res = await agent
      .post('/cart/items')
      .send({ productId: 'p_sticker', quantity: 2 })
      .expect(201);
    expect(res.body.totals.subtotalCents).toBe(998);
  });
});
