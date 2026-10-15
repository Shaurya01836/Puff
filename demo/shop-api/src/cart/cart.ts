import { findById, insert, update } from '../lib/db';
import { notFound } from '../lib/errors';
import { releaseStock, reserveStock } from '../products/inventory';
import { findProduct } from '../products/products';
import { applyDiscount, findDiscount } from './discounts';
import { taxFor } from './tax';

export interface CartLine {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface CartRow {
  id: string;
  lines: CartLine[];
  discountCode?: string;
}

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export function getCart(userId: string): CartRow {
  return findById<CartRow>('carts', userId) ?? insert<CartRow>('carts', { id: userId, lines: [] });
}

export function addItem(userId: string, productId: string, quantity: number): CartRow {
  const product = findProduct(productId);
  reserveStock(productId, quantity);
  const cart = getCart(userId);
  const existing = cart.lines.find((l) => l.productId === productId);
  const lines = existing
    ? cart.lines.map((l) =>
        l.productId === productId ? { ...l, quantity: l.quantity + quantity } : l,
      )
    : [
        ...cart.lines,
        { productId, name: product.name, unitPriceCents: product.priceCents, quantity },
      ];
  return update<CartRow>('carts', userId, { lines })!;
}

export function removeItem(userId: string, productId: string): CartRow {
  const cart = getCart(userId);
  const line = cart.lines.find((l) => l.productId === productId);
  if (!line) throw notFound(`Cart line ${productId}`);
  releaseStock(productId, line.quantity);
  return update<CartRow>('carts', userId, {
    lines: cart.lines.filter((l) => l.productId !== productId),
  })!;
}

export function setDiscount(userId: string, code: string): CartRow {
  findDiscount(code);
  getCart(userId);
  return update<CartRow>('carts', userId, { discountCode: code.toUpperCase() })!;
}

export function cartTotal(cart: CartRow): CartTotals {
  const subtotalCents = cart.lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  const discountCents = applyDiscount(subtotalCents, cart.discountCode);
  const taxCents = taxFor(subtotalCents - discountCents);
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}

export function clearCart(userId: string): void {
  update<CartRow>('carts', userId, { lines: [], discountCode: undefined });
}
