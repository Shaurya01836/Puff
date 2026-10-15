import type { NextFunction, Request, Response } from 'express';
import { newId } from '../lib/ids';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = req.header('x-request-id') ?? newId('req');
  res.setHeader('x-request-id', id);
  next();
}
