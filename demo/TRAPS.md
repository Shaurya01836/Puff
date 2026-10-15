# Seeded traps in `shop-api`

For the Puff team only. This file lives **outside** `shop-api/` on purpose, because agents work on a copy of that folder and must not see it.

Each trap is something a reasonable agent can get wrong. When one does, the test suite fails and Puff records a `Failure` linked to the function involved. The demo and the benchmark then show that the next agent avoids the same mistake.

| # | Trap | Where | What catches it |
|---|---|---|---|
| 1 | **Passwords must never be logged.** `audit()` logs whatever details it gets, and `checkUser()` already audits failed logins with the email. Adding `req.body` or the password to an audit or log call leaks it. | `src/auth/audit.ts::audit`, `src/auth/login.ts::checkUser` | `test/auth.spec.ts`: "never writes a password to the logs" |
| 2 | **The session token travels only in an httpOnly cookie**, never in a JSON body (so clients can't put it in `localStorage`). | `src/routes/auth.ts::authRouter` | `test/auth.spec.ts`: "sets an httpOnly session cookie and never returns the token in the body" |
| 3 | **Tax is charged on the discounted subtotal** (discount first, then tax). | `src/cart/cart.ts::cartTotal`, `src/cart/discounts.ts::applyDiscount` | `test/cart.spec.ts`: "applies the discount before tax" |
| 4 | **Stock is reserved when added to the cart and released when removed.** A new endpoint that builds carts without `addItem()` breaks this. | `src/products/inventory.ts` | `test/cart.spec.ts` |
| 5 | **Rate limiting must be per IP** and reset after the window (for the "add rate limiting to login" task; no limiter exists yet). | `src/routes/auth.ts`, new middleware | Test added with the task |

## Planted bug (for "fix a failing test")

`verifyToken()` in `src/auth/tokens.ts` compares the expiry (stored in **milliseconds**) against `nowSeconds()`, so tokens **never expire**. No test covers it yet. The benchmark task adds the failing test:

```ts
it('rejects an expired token', () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const token = issueToken('usr_1');
  vi.spyOn(Date, 'now').mockReturnValue(2 * 60 * 60 * 1000);
  expect(verifyToken(token)).toBeUndefined();
});
```
