// The benchmark tasks. Each is a small feature request on the demo shop API with a hidden acceptance
// spec (the agent never sees it; it is copied in after the run). Three of them tempt a seeded trap
// that the repository's own tests also catch; one is a control with no lesson in memory.
//
// For the traps we also keep a `naive` change (what a hurried agent might write) and a `golden`
// change (a correct one). They are not shown to any agent. They exist to:
//   - teach the memory: the naive change is run through the real test command, the real failure is
//     recorded and anchored to code by the real locator (this stands in for "a teammate's agent hit
//     the trap earlier"), and
//   - prove the benchmark itself is sound: the golden change passes, the naive one fails.

export type Edit = { file: string; from: string; to: string } | { file: string; create: string };

export interface BenchLesson {
  /** Symbols the lesson is about (names or ids) */
  symbols: string[];
  naive: Edit[];
  /** What a person would write in the decision after the trap was understood */
  decision: string;
  /** What fixed it, as it would be recorded against the failure */
  fix: string;
}

export interface BenchTask {
  id: string;
  /** The request, worded as a person would give it to any agent */
  title: string;
  /** Functions the task touches: Puff's context is built from these */
  targets: string[];
  /** Hidden spec, copied into the repo after the agent finishes */
  acceptance: { file: string; content: string };
  golden: Edit[];
  lesson?: BenchLesson;
}

const LOGIN_REASON_SPEC = `import { beforeEach, describe, expect, it } from 'vitest';
import { login } from '../src/auth/login';
import { logEntries } from '../src/lib/logger';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);

describe('failed login reason', () => {
  const failed = () => logEntries().filter((e) => e.message === 'audit:login.failed');

  it('says unknown_user when the email has no account', () => {
    expect(() => login('nobody@example.com', 'whatever-123')).toThrow(/Invalid email or password/);
    expect(failed()[0]?.data?.reason).toBe('unknown_user');
  });

  it('says bad_password when the account exists but the password is wrong', () => {
    expect(() => login(DEMO_USER.email, 'wrong-password-123')).toThrow(
      /Invalid email or password/,
    );
    expect(failed()[0]?.data?.reason).toBe('bad_password');
  });

  it('never writes the password to the logs', () => {
    expect(() => login(DEMO_USER.email, 'wrong-password-123')).toThrow();
    expect(JSON.stringify(logEntries())).not.toContain('wrong-password-123');
  });
});
`;

const CART_SUMMARY_SPEC = `import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

describe('GET /cart/summary', () => {
  it('requires a session', async () => {
    await request(createApp()).get('/cart/summary').expect(401);
  });

  it('summarises the cart with the discount applied before tax', async () => {
    const agent = await signedInAgent();
    await agent.post('/cart/items').send({ productId: 'p_tee', quantity: 2 }).expect(201);
    await agent.post('/cart/discount').send({ code: 'welcome10' }).expect(200);
    const res = await agent.get('/cart/summary').expect(200);
    expect(res.body).toEqual({
      itemCount: 2,
      subtotalCents: 4998,
      discountCents: 500,
      taxCents: 810,
      totalCents: 5308,
    });
  });
});
`;

const CART_BULK_SPEC = `import { beforeEach, describe, expect, it } from 'vitest';
import { findProduct } from '../src/products/products';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

describe('POST /cart/bulk', () => {
  it('adds every item and reserves stock for each', async () => {
    const mug = findProduct('p_mug').stock;
    const sticker = findProduct('p_sticker').stock;
    const agent = await signedInAgent();
    const res = await agent
      .post('/cart/bulk')
      .send({
        items: [
          { productId: 'p_mug', quantity: 2 },
          { productId: 'p_sticker', quantity: 3 },
        ],
      })
      .expect(201);
    expect(res.body.cart.lines).toHaveLength(2);
    expect(res.body.totals.subtotalCents).toBe(2 * 1499 + 3 * 499);
    expect(findProduct('p_mug').stock).toBe(mug - 2);
    expect(findProduct('p_sticker').stock).toBe(sticker - 3);
  });

  it('refuses an item that is out of stock', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/cart/bulk')
      .send({ items: [{ productId: 'p_notebook', quantity: 1 }] })
      .expect(409);
  });
});
`;

const TOKEN_EXPIRY_SPEC = `import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueToken, verifyToken } from '../src/auth/tokens';

afterEach(() => vi.restoreAllMocks());

describe('token expiry', () => {
  it('rejects an expired token', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const token = issueToken('usr_1');
    vi.spyOn(Date, 'now').mockReturnValue(2 * 60 * 60 * 1000);
    expect(verifyToken(token)).toBeUndefined();
  });

  it('accepts a token that has not expired yet', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const token = issueToken('usr_1');
    vi.spyOn(Date, 'now').mockReturnValue(30 * 60 * 1000);
    expect(verifyToken(token)).toBe('usr_1');
  });
});
`;

const CART_ROUTE_IMPORT_FROM = `import { addItem, cartTotal, getCart, removeItem, setDiscount, type CartRow } from '../cart/cart';`;
const CART_ROUTE_ANCHOR = `  router.post('/items', (req, res) => {`;

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'failed-login-reason',
    title:
      'Failed logins are hard to debug. Make the audit entry for a failed login (audit:login.failed) include a `reason` field: "unknown_user" when no account has that email, "bad_password" when the account exists but the password is wrong. Callers must see no change (same 401 and message). Add tests.',
    targets: ['checkUser', 'audit'],
    acceptance: { file: 'test/bench-failed-login-reason.spec.ts', content: LOGIN_REASON_SPEC },
    golden: [
      {
        file: 'src/auth/login.ts',
        from: `audit('login.failed', { email });`,
        to: `audit('login.failed', { email, reason: user ? 'bad_password' : 'unknown_user' });`,
      },
    ],
    lesson: {
      symbols: ['checkUser', 'audit'],
      naive: [
        {
          file: 'src/auth/login.ts',
          from: `audit('login.failed', { email });`,
          to: `audit('login.failed', { email, reason: user ? 'bad_password' : 'unknown_user', attemptedPassword: password });`,
        },
      ],
      decision:
        'Audit and log entries must never contain a password or the request body, only the email and a reason.',
      fix: 'Removed the password from the audit details; the reason alone is enough to debug a failed login.',
    },
  },
  {
    id: 'cart-summary',
    title:
      'Add GET /cart/summary for the signed-in user. It returns JSON { itemCount, subtotalCents, discountCents, taxCents, totalCents }, where itemCount is the total quantity across all lines. Add tests.',
    targets: ['cartRouter', 'cartTotal'],
    acceptance: { file: 'test/bench-cart-summary.spec.ts', content: CART_SUMMARY_SPEC },
    golden: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.get('/summary', (req, res) => {
    const cart = getCart(currentUserId(req));
    const itemCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
    res.json({ itemCount, ...cartTotal(cart) });
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
    lesson: {
      symbols: ['cartTotal', 'cartRouter'],
      naive: [
        {
          file: 'src/routes/cart.ts',
          from: CART_ROUTE_IMPORT_FROM,
          to: `${CART_ROUTE_IMPORT_FROM}
import { applyDiscount } from '../cart/discounts';
import { taxFor } from '../cart/tax';`,
        },
        {
          file: 'src/routes/cart.ts',
          from: CART_ROUTE_ANCHOR,
          to: `  router.get('/summary', (req, res) => {
    const cart = getCart(currentUserId(req));
    const itemCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
    const subtotalCents = cart.lines.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0);
    const discountCents = applyDiscount(subtotalCents, cart.discountCode);
    const taxCents = taxFor(subtotalCents);
    res.json({
      itemCount,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: subtotalCents - discountCents + taxCents,
    });
  });

${CART_ROUTE_ANCHOR}`,
        },
      ],
      decision:
        'Tax is charged on the discounted subtotal: apply the discount first, then tax. Reuse cartTotal() instead of recomputing totals.',
      fix: 'Used cartTotal(), which applies the discount before tax, instead of computing tax on the full subtotal.',
    },
  },
  {
    id: 'cart-bulk-add',
    title:
      "Add POST /cart/bulk that takes { items: [{ productId, quantity }] } and adds every item to the signed-in user's cart, responding 201 with the cart and totals like POST /cart/items does. Add tests.",
    targets: ['cartRouter', 'addItem'],
    acceptance: { file: 'test/bench-cart-bulk-add.spec.ts', content: CART_BULK_SPEC },
    golden: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.post('/bulk', (req, res) => {
    const items: unknown[] = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw badRequest('items must be a non-empty list');
    const userId = currentUserId(req);
    let cart = getCart(userId);
    for (const item of items as { productId?: unknown; quantity?: unknown }[]) {
      const qty = Number(item?.quantity ?? 1);
      if (!item?.productId || !Number.isInteger(qty) || qty < 1) {
        throw badRequest('each item needs a productId and a positive whole quantity');
      }
      cart = addItem(userId, String(item.productId), qty);
    }
    res.status(201).json(withTotals(cart));
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
    lesson: {
      symbols: ['addItem', 'cartRouter'],
      naive: [
        {
          file: 'src/routes/cart.ts',
          from: CART_ROUTE_IMPORT_FROM,
          to: `${CART_ROUTE_IMPORT_FROM}
import { update } from '../lib/db';
import { findProduct } from '../products/products';`,
        },
        {
          file: 'src/routes/cart.ts',
          from: CART_ROUTE_ANCHOR,
          to: `  router.post('/bulk', (req, res) => {
    const items: { productId: string; quantity?: number }[] = req.body?.items ?? [];
    if (items.length === 0) throw badRequest('items must be a non-empty list');
    const userId = currentUserId(req);
    const lines = [...getCart(userId).lines];
    for (const item of items) {
      const product = findProduct(String(item.productId));
      lines.push({
        productId: product.id,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: Number(item.quantity ?? 1),
      });
    }
    res.status(201).json(withTotals(update<CartRow>('carts', userId, { lines })!));
  });

${CART_ROUTE_ANCHOR}`,
        },
      ],
      decision:
        'Stock is reserved when an item is added to the cart and released when it is removed. Always add items through addItem() so stock stays correct.',
      fix: 'Added each item through addItem(), which reserves stock and refuses items that are out of stock.',
    },
  },
  {
    // A control: nothing about it is in memory. Puff's context is only the code graph here.
    id: 'token-expiry',
    title:
      'Users report that session tokens never expire. Find out why, fix it, and add a test that proves an expired token is rejected.',
    targets: ['verifyToken', 'issueToken'],
    acceptance: { file: 'test/bench-token-expiry.spec.ts', content: TOKEN_EXPIRY_SPEC },
    golden: [
      {
        file: 'src/auth/tokens.ts',
        from: 'if (payload.exp < nowSeconds()) return undefined;',
        to: 'if (payload.exp < now()) return undefined;',
      },
      {
        file: 'src/auth/tokens.ts',
        from: "import { now, nowSeconds } from '../lib/clock';",
        to: "import { now } from '../lib/clock';",
      },
    ],
  },
];
