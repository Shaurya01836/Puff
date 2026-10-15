import { Router } from 'express';
import { findProduct, searchProducts } from '../products/products';

export function productsRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ products: searchProducts(String(req.query.q ?? '')) });
  });

  router.get('/:id', (req, res) => {
    res.json({ product: findProduct(req.params.id) });
  });

  return router;
}
