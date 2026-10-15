import { beforeEach, describe, expect, it } from 'vitest';
import { findProduct, listProducts, searchProducts } from '../src/products/products';
import { resetAll } from './helpers';

beforeEach(resetAll);

describe('products', () => {
  it('lists products alphabetically', () => {
    expect(listProducts().map((p) => p.name)[0]).toBe('Deep Sea Hoodie');
  });

  it('searches case-insensitively', () => {
    expect(searchProducts('MUG').map((p) => p.id)).toEqual(['p_mug']);
    expect(searchProducts('  ')).toHaveLength(5);
  });

  it('throws for an unknown product', () => {
    expect(() => findProduct('p_nope')).toThrow(/not found/);
  });
});
