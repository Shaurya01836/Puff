import { Router } from 'express';
import { addItem, cartTotal, getCart, removeItem, setDiscount, type CartRow } from '../cart/cart';
import { badRequest } from '../lib/errors';
import { currentUserId, requireAuth } from '../middleware/requireAuth';

const withTotals = (cart: CartRow) => ({ cart, totals: cartTotal(cart) });

export function cartRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json(withTotals(getCart(currentUserId(req))));
  });

  router.post('/items', (req, res) => {
    const { productId, quantity } = req.body ?? {};
    const qty = Number(quantity ?? 1);
    if (!productId || !Number.isInteger(qty) || qty < 1) {
      throw badRequest('productId and a positive whole quantity are required');
    }
    res.status(201).json(withTotals(addItem(currentUserId(req), String(productId), qty)));
  });

  router.delete('/items/:productId', (req, res) => {
    res.json(withTotals(removeItem(currentUserId(req), req.params.productId)));
  });

  router.post('/discount', (req, res) => {
    res.json(withTotals(setDiscount(currentUserId(req), String(req.body?.code ?? ''))));
  });

  return router;
}
