import { findById, query } from '../lib/db';
import { notFound } from '../lib/errors';

export interface ProductRow {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

export function listProducts(): ProductRow[] {
  return query<ProductRow>('products').sort((a, b) => a.name.localeCompare(b.name));
}

export function findProduct(id: string): ProductRow {
  const product = findById<ProductRow>('products', id);
  if (!product) throw notFound(`Product ${id}`);
  return product;
}

export function searchProducts(term: string): ProductRow[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return listProducts();
  return listProducts().filter((p) => p.name.toLowerCase().includes(needle));
}
