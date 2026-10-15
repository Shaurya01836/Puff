import { update } from '../lib/db';
import { conflict } from '../lib/errors';
import { findProduct, type ProductRow } from './products';

export function reserveStock(productId: string, quantity: number): void {
  const product = findProduct(productId);
  if (product.stock < quantity) throw conflict(`Only ${product.stock} of ${product.name} left`);
  update<ProductRow>('products', productId, { stock: product.stock - quantity });
}

export function releaseStock(productId: string, quantity: number): void {
  const product = findProduct(productId);
  update<ProductRow>('products', productId, { stock: product.stock + quantity });
}
