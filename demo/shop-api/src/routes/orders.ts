import { Router } from 'express';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { getOrder, placeOrder } from '../orders/orders';

export function ordersRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/', (req, res) => {
    res
      .status(201)
      .json({ order: placeOrder(currentUserId(req), String(req.body?.cardToken ?? '')) });
  });

  router.get('/:id', (req, res) => {
    res.json({ order: getOrder(currentUserId(req), req.params.id) });
  });

  return router;
}
