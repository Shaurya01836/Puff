import { Router } from 'express';
import { login } from '../auth/login';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';

export function authRouter(): Router {
  const router = Router();

  router.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const { user, session } = login(String(email ?? ''), String(password ?? ''));
    // The token travels only in an httpOnly cookie, never in the response body.
    res.cookie(config.sessionCookie, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: config.tokenTtlSeconds * 1000,
    });
    res.json({ user });
  });

  router.post('/logout', requireAuth, (req, res) => {
    req.session?.end();
    res.clearCookie(config.sessionCookie);
    res.status(204).end();
  });

  return router;
}
