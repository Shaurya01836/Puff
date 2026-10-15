import { Router } from 'express';
import { notFound } from '../lib/errors';
import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { createUser, findUserById, publicUser } from '../users/users';

export function usersRouter(): Router {
  const router = Router();

  router.post('/', (req, res) => {
    res.status(201).json({ user: createUser(req.body ?? {}) });
  });

  router.get('/me', requireAuth, (req, res) => {
    const user = findUserById(currentUserId(req));
    if (!user) throw notFound('User');
    res.json({ user: publicUser(user) });
  });

  return router;
}
