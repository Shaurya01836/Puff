import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { now, nowSeconds } from '../lib/clock';

interface TokenPayload {
  sub: string;
  /** Expiry time */
  exp: number;
}

function sign(body: string): string {
  return createHmac('sha256', config.tokenSecret).update(body).digest('base64url');
}

export function issueToken(userId: string): string {
  const payload: TokenPayload = { sub: userId, exp: now() + config.tokenTtlSeconds * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Returns the user id for a valid, unexpired token, otherwise undefined. */
export function verifyToken(token: string): string | undefined {
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
  if (payload.exp < nowSeconds()) return undefined;
  return payload.sub;
}
