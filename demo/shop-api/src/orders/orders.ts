import { audit } from '../auth/audit';
import { cartTotal, clearCart, getCart, type CartLine } from '../cart/cart';
import { now } from '../lib/clock';
import { findById, insert } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { chargeCard } from './payments';

export interface OrderRow {
  id: string;
  userId: string;
  lines: CartLine[];
  totalCents: number;
  chargeId: string;
  placedAt: number;
}

export function placeOrder(userId: string, cardToken: string): OrderRow {
  const cart = getCart(userId);
  if (cart.lines.length === 0) throw badRequest('Cart is empty');
  const { totalCents } = cartTotal(cart);
  const charge = chargeCard(cardToken, totalCents);
  const order = insert<OrderRow>('orders', {
    id: newId('ord'),
    userId,
    lines: cart.lines,
    totalCents,
    chargeId: charge.id,
    placedAt: now(),
  });
  clearCart(userId);
  audit('order.placed', { userId, orderId: order.id, totalCents });
  return order;
}

export function getOrder(userId: string, orderId: string): OrderRow {
  const order = findById<OrderRow>('orders', orderId);
  if (!order || order.userId !== userId) throw notFound(`Order ${orderId}`);
  return order;
}
