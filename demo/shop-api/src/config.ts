export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** Secret used to sign session tokens. Never logged. */
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-only-secret-change-me',
  tokenTtlSeconds: 60 * 60,
  sessionCookie: 'sid',
  /** Tax rate applied to the discounted subtotal */
  taxRate: 0.18,
};
