import type { NextFunction, Request, Response } from 'express';
import { findSession, type Session } from '../auth/session';
import { config } from '../config';
import { unauthorized } from '../lib/errors';

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req, config.sessionCookie);
  const session = token ? findSession(token) : undefined;
  if (!session) return next(unauthorized());
  req.session = session;
  next();
}

/** The signed-in user's id. Only valid after requireAuth. */
export function currentUserId(req: Request): string {
  if (!req.session) throw unauthorized();
  return req.session.userId;
}
