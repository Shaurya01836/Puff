import express, { type Express } from 'express';
import { errorHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { authRouter } from './routes/auth';
import { cartRouter } from './routes/cart';
import { ordersRouter } from './routes/orders';
import { productsRouter } from './routes/products';
import { usersRouter } from './routes/users';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/auth', authRouter());
  app.use('/users', usersRouter());
  app.use('/products', productsRouter());
  app.use('/cart', cartRouter());
  app.use('/orders', ordersRouter());

  app.use(errorHandler);
  return app;
}
