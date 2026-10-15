import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import { log } from '../lib/logger';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  log('error', 'unhandled error', { path: req.path, message: (err as Error)?.message });
  res.status(500).json({ error: 'Something went wrong' });
}
