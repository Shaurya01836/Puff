import { insert } from './lib/db';
import type { ProductRow } from './products/products';
import { createUser } from './users/users';

export const DEMO_USER = {
  email: 'demo@shop.test',
  password: 'correct-horse-42',
  name: 'Demo User',
};

const PRODUCTS: ProductRow[] = [
  { id: 'p_mug', name: 'Octopus Mug', priceCents: 1499, stock: 25 },
  { id: 'p_tee', name: 'Graph Tee', priceCents: 2499, stock: 40 },
  { id: 'p_sticker', name: 'Sticker Pack', priceCents: 499, stock: 200 },
  { id: 'p_hoodie', name: 'Deep Sea Hoodie', priceCents: 5999, stock: 8 },
  { id: 'p_notebook', name: 'Dotted Notebook', priceCents: 999, stock: 0 },
];

export function seedDemoData(): void {
  for (const p of PRODUCTS) insert<ProductRow>('products', { ...p });
  createUser(DEMO_USER);
}
