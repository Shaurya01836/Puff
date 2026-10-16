// The lesson-transfer benchmark (P14): does a lesson one agent learned stop the next agent from
// repeating the mistake on a different, related task?
//
// For each of the five traps in demo/TRAPS.md there are two tasks:
//   learn     a tempting task. A real agent tries it first; if it does not fall into the trap, the
//             recorded careless change is applied instead ("replayed"). Either way the real tests fail
//             and Puff's real failure locator pins the failure to the function, with its fix and a decision.
//   transfer  a different task on related code, which an informed engineer could do correctly.
//
// Every transfer task is run by a fresh agent in four arms:
//   none       the task alone (no memory)
//   puff       Puff's context, chosen by the graph
//   flat       the same lessons written into AGENTS.md in the repo, with no selection
//   graph-off  Puff with PUFF_GRAPH=off: the task and its target files only
//
// A repeated mistake is a trap test failing on the first (and only) attempt.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FalkorDB, Graph } from 'falkordb';
import type { AgentName } from '@puff/shared';
import type { Adapters } from '../agents/adapters';
import type { HarnessResult } from '../agents/types';
import type { PuffConfig } from '../config';
import { compileContext } from '../context/compiler';
import { estimateTokens } from '../context/prompt';
import { projectGraph, read } from '../db/client';
import { initProjectGraph } from '../db/init';
import { setupDemoWorkspace } from '../git/demo';
import { git, removeLink } from '../git/repo';
import { indexRepo } from '../indexer/index';
import { recordTestFailures } from '../memory/failures';
import { parseTestFailures } from '../memory/locate';
import { recordDecision, recordSolution } from '../memory/memory';
import { finishSession, startSession } from '../memory/sessions';
import { createTask, updateTask } from '../memory/tasks';
import { resolveSymbols } from '../queries/code';
import { runVerification, type Verdict } from '../orchestrator/verify';
import { applyEdits, plainPrompt, writeAcceptance } from './runner';
import { BENCH_TASKS, type BenchTask, type Edit } from './tasks';

export type TransferArm = 'none' | 'puff' | 'flat' | 'graph-off';
export const TRANSFER_ARMS: TransferArm[] = ['none', 'puff', 'flat', 'graph-off'];

export interface TransferTask {
  id: string;
  /** Trap number in demo/TRAPS.md */
  trap: number;
  /** The request, worded as a person would give it to any agent */
  title: string;
  targets: string[];
  acceptance: { file: string; content: string };
  /** Names of the tests (hidden spec or the repo's own) that fail when the trap is hit */
  trapTests: string[];
  /** A correct change, to prove the task is fair (none for "the right answer is to refuse") */
  golden: Edit[];
  /** The mistake, to prove the trap tests catch it */
  naive: Edit[];
  /** Doing nothing (refusing, and saying why) is a correct answer */
  noChangeOk?: boolean;
}

export interface LearnTask extends BenchTask {
  trap: number;
  /** Tests that fail when the trap is hit, in the learn task's own spec or the repo's tests */
  trapTests: string[];
  lesson: NonNullable<BenchTask['lesson']>;
}

// ---------------------------------------------------------------------------------------------
// Learn tasks: three come from the first benchmark, two are new
// ---------------------------------------------------------------------------------------------

const SESSION_INFO_SPEC = `import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);

async function signIn() {
  const res = await request(createApp())
    .post('/auth/login')
    .send({ email: DEMO_USER.email, password: DEMO_USER.password })
    .expect(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { cookie, token: decodeURIComponent(cookie.split('=')[1]!) };
}

describe('GET /auth/session', () => {
  it('requires a session', async () => {
    await request(createApp()).get('/auth/session').expect(401);
  });

  it('returns the signed-in user and when the session started', async () => {
    const { cookie } = await signIn();
    const res = await request(createApp()).get('/auth/session').set('Cookie', cookie).expect(200);
    expect(res.body.user.email).toBe(DEMO_USER.email);
    expect(typeof res.body.session.startedAt).toBe('number');
  });

  it('never returns the session token in the body', async () => {
    const { cookie, token } = await signIn();
    const res = await request(createApp()).get('/auth/session').set('Cookie', cookie).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });
});
`;

const RATE_LIMIT_HELPERS = `import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterEach(() => vi.useRealTimers());

/** The app as it runs behind a proxy, so each request can come from its own client IP */
function appWithIps() {
  const app = createApp();
  app.set('trust proxy', true);
  return app;
}
`;

const SIGNUP_LIMIT_SPEC = `${RATE_LIMIT_HELPERS}
let n = 0;
const signUp = (app: ReturnType<typeof createApp>, ip: string) =>
  request(app)
    .post('/users')
    .set('X-Forwarded-For', ip)
    .send({ email: 'new' + ++n + '@example.com', password: 'long-enough-1', name: 'New' });

describe('sign-up rate limit', () => {
  it('allows 3 sign-ups a minute from one client and answers 429 after that', async () => {
    const app = appWithIps();
    for (let i = 0; i < 3; i++) await signUp(app, '10.0.0.1').expect(201);
    await signUp(app, '10.0.0.1').expect(429);
  });

  it('limits each client IP separately', async () => {
    const app = appWithIps();
    for (let i = 0; i < 3; i++) await signUp(app, '10.0.1.1').expect(201);
    await signUp(app, '10.0.1.2').expect(201);
  });

  it('lets the client sign up again after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = appWithIps();
    for (let i = 0; i < 3; i++) await signUp(app, '10.0.2.1').expect(201);
    await signUp(app, '10.0.2.1').expect(429);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await signUp(app, '10.0.2.1').expect(201);
  });

  it('keeps login working for everyone', async () => {
    await request(appWithIps())
      .post('/auth/login')
      .send({ email: DEMO_USER.email, password: DEMO_USER.password })
      .expect(200);
  });
});
`;

const USERS_ROUTER_ANCHOR = `  router.post('/', (req, res) => {`;
const AUTH_LOGIN_ANCHOR = `  router.post('/login', (req, res) => {`;
const AUTH_IMPORT = `import { login } from '../auth/login';`;
const CART_ROUTE_IMPORT = `import { addItem, cartTotal, getCart, removeItem, setDiscount, type CartRow } from '../cart/cart';`;
const CART_ROUTE_ANCHOR = `  router.post('/items', (req, res) => {`;

const LEARN_EXTRA: LearnTask[] = [
  {
    id: 'session-info',
    trap: 2,
    title:
      'Add GET /auth/session for the signed-in user. It returns JSON { user, session } with the details of the current session, so the client can show who is signed in and since when. Add tests.',
    targets: ['authRouter'],
    acceptance: { file: 'test/bench-session-info.spec.ts', content: SESSION_INFO_SPEC },
    trapTests: ['never returns the session token in the body'],
    golden: [
      {
        file: 'src/auth/session.ts',
        from: `  get userId(): string {`,
        to: `  get startedAt(): number {
    return this.row.startedAt;
  }

  get userId(): string {`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `import { requireAuth } from '../middleware/requireAuth';`,
        to: `import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { findUserById, publicUser } from '../users/users';`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `  router.post('/logout', requireAuth, (req, res) => {`,
        to: `  router.get('/session', requireAuth, (req, res) => {
    const user = findUserById(currentUserId(req));
    res.json({
      user: user ? publicUser(user) : null,
      session: { id: req.session!.id, startedAt: req.session!.startedAt },
    });
  });

  router.post('/logout', requireAuth, (req, res) => {`,
      },
    ],
    lesson: {
      symbols: ['authRouter'],
      naive: [
        {
          file: 'src/auth/session.ts',
          from: `  get userId(): string {`,
          to: `  get startedAt(): number {
    return this.row.startedAt;
  }

  get userId(): string {`,
        },
        {
          file: 'src/routes/auth.ts',
          from: `import { requireAuth } from '../middleware/requireAuth';`,
          to: `import { currentUserId, requireAuth } from '../middleware/requireAuth';
import { findUserById, publicUser } from '../users/users';`,
        },
        {
          file: 'src/routes/auth.ts',
          from: `  router.post('/logout', requireAuth, (req, res) => {`,
          to: `  router.get('/session', requireAuth, (req, res) => {
    const user = findUserById(currentUserId(req));
    const s = req.session!;
    res.json({
      user: user ? publicUser(user) : null,
      session: { id: s.id, token: s.token, startedAt: s.startedAt },
    });
  });

  router.post('/logout', requireAuth, (req, res) => {`,
        },
      ],
      decision:
        'The session token travels only in the httpOnly cookie. Never put it in a response body, not even for the signed-in user.',
      fix: 'Removed the token from the GET /auth/session response; the cookie already carries it.',
    },
  },
  {
    id: 'signup-rate-limit',
    trap: 5,
    title:
      'Add rate limiting to sign-up (POST /users): allow at most 3 sign-ups per minute, and answer 429 with an error message after that. Add tests.',
    targets: ['usersRouter'],
    acceptance: { file: 'test/bench-signup-rate-limit.spec.ts', content: SIGNUP_LIMIT_SPEC },
    trapTests: ['limits each client IP separately', 'lets the client sign up again after a minute'],
    golden: [
      {
        file: 'src/routes/users.ts',
        from: `import { notFound } from '../lib/errors';`,
        to: `import { now } from '../lib/clock';
import { notFound } from '../lib/errors';

const WINDOW_MS = 60_000;
const MAX_SIGN_UPS = 3;
const signUps = new Map<string, { count: number; since: number }>();`,
      },
      {
        file: 'src/routes/users.ts',
        from: USERS_ROUTER_ANCHOR,
        to: `  router.post('/', (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const t = now();
    const seen = signUps.get(key);
    if (!seen || t - seen.since >= WINDOW_MS) signUps.set(key, { count: 1, since: t });
    else if (seen.count >= MAX_SIGN_UPS) {
      res.status(429).json({ error: 'Too many sign-ups. Try again in a minute.' });
      return;
    } else seen.count++;
    next();
  });

${USERS_ROUTER_ANCHOR}`,
      },
    ],
    lesson: {
      symbols: ['usersRouter'],
      naive: [
        {
          file: 'src/routes/users.ts',
          from: `import { notFound } from '../lib/errors';`,
          to: `import { notFound } from '../lib/errors';

let signUps = 0;`,
        },
        {
          file: 'src/routes/users.ts',
          from: USERS_ROUTER_ANCHOR,
          to: `  router.post('/', (_req, res, next) => {
    if (++signUps > 3) {
      res.status(429).json({ error: 'Too many sign-ups. Try again later.' });
      return;
    }
    next();
  });

${USERS_ROUTER_ANCHOR}`,
        },
      ],
      decision:
        'Rate limits are counted per client IP (req.ip) and reset when the window has passed. One global counter locks every user out and never recovers.',
      fix: 'Counted requests per req.ip in a one-minute window that resets.',
    },
  },
];

/** Tests that fail when the first benchmark's tasks hit their trap */
const FIRST_BENCH_TRAPS: Record<string, { trap: number; tests: string[] }> = {
  'failed-login-reason': {
    trap: 1,
    tests: ['never writes the password to the logs', 'never writes a password to the logs'],
  },
  'cart-summary': {
    trap: 3,
    tests: [
      'summarises the cart with the discount applied before tax',
      'applies the discount before tax',
    ],
  },
  'cart-bulk-add': {
    trap: 4,
    tests: ['adds every item and reserves stock for each', 'refuses an item that is out of stock'],
  },
};

export const LEARN_TASKS: LearnTask[] = [
  ...BENCH_TASKS.filter((t) => t.lesson && FIRST_BENCH_TRAPS[t.id]).map((t) => ({
    ...t,
    lesson: t.lesson!,
    trap: FIRST_BENCH_TRAPS[t.id]!.trap,
    trapTests: FIRST_BENCH_TRAPS[t.id]!.tests,
  })),
  ...LEARN_EXTRA,
].sort((a, b) => a.trap - b.trap);

// ---------------------------------------------------------------------------------------------
// Transfer tasks
// ---------------------------------------------------------------------------------------------

const LOGIN_LOG_SPEC = `import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { logEntries } from '../src/lib/logger';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);

const send = (password: string) =>
  request(createApp()).post('/auth/login').send({ email: DEMO_USER.email, password });

describe('login request log', () => {
  const requests = () => logEntries().filter((e) => e.message === 'login.request');

  it('logs every login request with the email', async () => {
    await send(DEMO_USER.password).expect(200);
    await send('wrong-password-123').expect(401);
    expect(requests()).toHaveLength(2);
    for (const e of requests()) {
      expect(e.level).toBe('info');
      expect(JSON.stringify(e.data ?? {})).toContain(DEMO_USER.email);
    }
  });

  it('never writes the password to the logs', async () => {
    await send('wrong-password-123').expect(401);
    await send(DEMO_USER.password).expect(200);
    const logged = JSON.stringify(logEntries());
    expect(logged).not.toContain('wrong-password-123');
    expect(logged).not.toContain(DEMO_USER.password);
  });
});
`;

const TOKEN_BODY_SPEC = `import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);

describe('login response', () => {
  it('keeps the session in an httpOnly cookie and never returns the token in the body', async () => {
    const res = await request(createApp())
      .post('/auth/login')
      .send({ email: DEMO_USER.email, password: DEMO_USER.password })
      .expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    const token = decodeURIComponent(/sid=([^;]+)/.exec(cookie)![1]!);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });
});
`;

const CART_QUOTE_SPEC = `import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

describe('POST /cart/quote', () => {
  it('requires a session', async () => {
    await request(createApp()).post('/cart/quote').send({ discountCode: 'welcome10' }).expect(401);
  });

  it('quotes the discount and charges tax after it', async () => {
    const agent = await signedInAgent();
    await agent.post('/cart/items').send({ productId: 'p_tee', quantity: 2 }).expect(201);
    const res = await agent.post('/cart/quote').send({ discountCode: 'welcome10' }).expect(200);
    expect(res.body).toEqual({
      subtotalCents: 4998,
      discountCents: 500,
      taxCents: 810,
      totalCents: 5308,
    });
  });

  it('does not change the cart', async () => {
    const agent = await signedInAgent();
    await agent.post('/cart/items').send({ productId: 'p_tee', quantity: 2 }).expect(201);
    await agent.post('/cart/quote').send({ discountCode: 'welcome10' }).expect(200);
    const cart = await agent.get('/cart').expect(200);
    expect(cart.body.cart.discountCode).toBeUndefined();
    expect(cart.body.totals.discountCents).toBe(0);
  });

  it('rejects an unknown code with 400', async () => {
    const agent = await signedInAgent();
    await agent.post('/cart/quote').send({ discountCode: 'nope' }).expect(400);
  });
});
`;

const CART_REORDER_SPEC = `import { beforeEach, describe, expect, it } from 'vitest';
import { findProduct } from '../src/products/products';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

async function pastOrder(productId: string, quantity: number) {
  const agent = await signedInAgent();
  await agent.post('/cart/items').send({ productId, quantity }).expect(201);
  const res = await agent.post('/orders').send({ cardToken: 'tok_visa' }).expect(201);
  return { agent, orderId: res.body.order.id as string };
}

describe('POST /cart/reorder', () => {
  it('puts the lines of a past order back in the cart and reserves stock for each', async () => {
    const { agent, orderId } = await pastOrder('p_mug', 2);
    const before = findProduct('p_mug').stock;
    const res = await agent.post('/cart/reorder').send({ orderId }).expect(201);
    expect(res.body.cart.lines).toEqual([
      expect.objectContaining({ productId: 'p_mug', quantity: 2 }),
    ]);
    expect(res.body.totals.subtotalCents).toBe(2 * 1499);
    expect(findProduct('p_mug').stock).toBe(before - 2);
  });

  it('refuses with 409 when an item is out of stock', async () => {
    const { agent, orderId } = await pastOrder('p_hoodie', 8);
    await agent.post('/cart/reorder').send({ orderId }).expect(409);
  });
});
`;

const LOGIN_LOCKOUT_SPEC = `${RATE_LIMIT_HELPERS}
const attempt = (app: ReturnType<typeof createApp>, ip: string, password: string) =>
  request(app).post('/auth/login').set('X-Forwarded-For', ip).send({ email: DEMO_USER.email, password });

describe('login brute-force protection', () => {
  it('answers 429 after 5 failed attempts from one client', async () => {
    const app = appWithIps();
    for (let i = 0; i < 5; i++) await attempt(app, '10.1.0.1', 'wrong-password-1').expect(401);
    await attempt(app, '10.1.0.1', 'wrong-password-1').expect(429);
  });

  it('limits each client IP separately', async () => {
    const app = appWithIps();
    for (let i = 0; i < 5; i++) await attempt(app, '10.1.1.1', 'wrong-password-1').expect(401);
    await attempt(app, '10.1.1.2', DEMO_USER.password).expect(200);
  });

  it('lets the client try again after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = appWithIps();
    for (let i = 0; i < 5; i++) await attempt(app, '10.1.2.1', 'wrong-password-1').expect(401);
    await attempt(app, '10.1.2.1', DEMO_USER.password).expect(429);
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await attempt(app, '10.1.2.1', DEMO_USER.password).expect(200);
  });

  it('does not count successful logins', async () => {
    const app = appWithIps();
    for (let i = 0; i < 7; i++) await attempt(app, '10.1.3.1', DEMO_USER.password).expect(200);
  });
});
`;

export const TRANSFER_TASKS: TransferTask[] = [
  {
    id: 'login-request-log',
    trap: 1,
    title:
      'Support cannot tell why logins fail. In POST /auth/login, add a log entry (level "info", message "login.request") for every incoming login request, with what the client sent, so support can see it. Add tests.',
    targets: ['authRouter'],
    acceptance: { file: 'test/bench-login-request-log.spec.ts', content: LOGIN_LOG_SPEC },
    trapTests: ['never writes the password to the logs', 'never writes a password to the logs'],
    golden: [
      {
        file: 'src/routes/auth.ts',
        from: AUTH_IMPORT,
        to: `${AUTH_IMPORT}\nimport { log } from '../lib/logger';`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `    const { email, password } = req.body ?? {};`,
        to: `    const { email, password } = req.body ?? {};
    log('info', 'login.request', { email: String(email ?? '') });`,
      },
    ],
    naive: [
      {
        file: 'src/routes/auth.ts',
        from: AUTH_IMPORT,
        to: `${AUTH_IMPORT}\nimport { log } from '../lib/logger';`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `    const { email, password } = req.body ?? {};`,
        to: `    const { email, password } = req.body ?? {};
    log('info', 'login.request', { ...req.body });`,
      },
    ],
  },
  {
    id: 'token-in-body',
    trap: 2,
    title:
      'The mobile app cannot read cookies. Return the session token in the POST /auth/login response so the mobile app can store it.',
    targets: ['authRouter'],
    acceptance: { file: 'test/bench-token-in-body.spec.ts', content: TOKEN_BODY_SPEC },
    trapTests: [
      'keeps the session in an httpOnly cookie and never returns the token in the body',
      'sets an httpOnly session cookie and never returns the token in the body',
    ],
    golden: [],
    noChangeOk: true,
    naive: [
      {
        file: 'src/routes/auth.ts',
        from: `    res.json({ user });`,
        to: `    res.json({ user, token: session.token });`,
      },
    ],
  },
  {
    id: 'cart-quote',
    trap: 3,
    title:
      'Add POST /cart/quote for the signed-in user. It takes { discountCode } and returns what the cart would cost with that code, as JSON { subtotalCents, discountCents, taxCents, totalCents }. It must not change the cart. Add tests.',
    targets: ['cartRouter', 'cartTotal'],
    acceptance: { file: 'test/bench-cart-quote.spec.ts', content: CART_QUOTE_SPEC },
    trapTests: ['quotes the discount and charges tax after it'],
    golden: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_IMPORT,
        to: `${CART_ROUTE_IMPORT}\nimport { findDiscount } from '../cart/discounts';`,
      },
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.post('/quote', (req, res) => {
    const code = String(req.body?.discountCode ?? '');
    findDiscount(code);
    const cart = getCart(currentUserId(req));
    res.json(cartTotal({ ...cart, discountCode: code.toUpperCase() }));
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
    naive: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_IMPORT,
        to: `${CART_ROUTE_IMPORT}
import { applyDiscount } from '../cart/discounts';
import { taxFor } from '../cart/tax';`,
      },
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.post('/quote', (req, res) => {
    const cart = getCart(currentUserId(req));
    const subtotalCents = cart.lines.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0);
    const discountCents = applyDiscount(subtotalCents, String(req.body?.discountCode ?? ''));
    const taxCents = taxFor(subtotalCents);
    res.json({ subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents });
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
  },
  {
    id: 'cart-reorder',
    trap: 4,
    title:
      "Add POST /cart/reorder for the signed-in user. It takes { orderId } and puts every line of that past order back into the user's cart (same products and quantities), responding 201 with the cart and totals like POST /cart/items does. Add tests.",
    targets: ['cartRouter', 'getOrder'],
    acceptance: { file: 'test/bench-cart-reorder.spec.ts', content: CART_REORDER_SPEC },
    trapTests: [
      'puts the lines of a past order back in the cart and reserves stock for each',
      'refuses with 409 when an item is out of stock',
    ],
    golden: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_IMPORT,
        to: `${CART_ROUTE_IMPORT}\nimport { getOrder } from '../orders/orders';`,
      },
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.post('/reorder', (req, res) => {
    const userId = currentUserId(req);
    const order = getOrder(userId, String(req.body?.orderId ?? ''));
    let cart = getCart(userId);
    for (const line of order.lines) cart = addItem(userId, line.productId, line.quantity);
    res.status(201).json(withTotals(cart));
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
    naive: [
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_IMPORT,
        to: `${CART_ROUTE_IMPORT}
import { update } from '../lib/db';
import { getOrder } from '../orders/orders';`,
      },
      {
        file: 'src/routes/cart.ts',
        from: CART_ROUTE_ANCHOR,
        to: `  router.post('/reorder', (req, res) => {
    const userId = currentUserId(req);
    const order = getOrder(userId, String(req.body?.orderId ?? ''));
    const lines = [...getCart(userId).lines, ...order.lines];
    res.status(201).json(withTotals(update<CartRow>('carts', userId, { lines })!));
  });

${CART_ROUTE_ANCHOR}`,
      },
    ],
  },
  {
    id: 'login-lockout',
    trap: 5,
    title:
      'Add brute-force protection to login: after 5 failed login attempts within a minute, POST /auth/login answers 429 with an error message until the minute is over. Successful logins do not count. Add tests.',
    targets: ['authRouter'],
    acceptance: { file: 'test/bench-login-lockout.spec.ts', content: LOGIN_LOCKOUT_SPEC },
    trapTests: ['limits each client IP separately', 'lets the client try again after a minute'],
    golden: [
      {
        file: 'src/routes/auth.ts',
        from: AUTH_IMPORT,
        to: `${AUTH_IMPORT}
import { now } from '../lib/clock';

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; since: number }>();`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `    const { email, password } = req.body ?? {};
    const { user, session } = login(String(email ?? ''), String(password ?? ''));`,
        to: `    const { email, password } = req.body ?? {};
    const key = req.ip ?? 'unknown';
    const t = now();
    const seen = failures.get(key);
    if (seen && t - seen.since >= WINDOW_MS) failures.delete(key);
    if ((failures.get(key)?.count ?? 0) >= MAX_FAILURES) {
      res.status(429).json({ error: 'Too many failed logins. Try again in a minute.' });
      return;
    }
    let result;
    try {
      result = login(String(email ?? ''), String(password ?? ''));
    } catch (err) {
      const f = failures.get(key) ?? { count: 0, since: t };
      f.count++;
      failures.set(key, f);
      throw err;
    }
    const { user, session } = result;`,
      },
    ],
    naive: [
      {
        file: 'src/routes/auth.ts',
        from: AUTH_IMPORT,
        to: `${AUTH_IMPORT}

let failedLogins = 0;`,
      },
      {
        file: 'src/routes/auth.ts',
        from: `    const { email, password } = req.body ?? {};
    const { user, session } = login(String(email ?? ''), String(password ?? ''));`,
        to: `    const { email, password } = req.body ?? {};
    if (failedLogins >= 5) {
      res.status(429).json({ error: 'Too many failed logins.' });
      return;
    }
    let result;
    try {
      result = login(String(email ?? ''), String(password ?? ''));
    } catch (err) {
      failedLogins++;
      throw err;
    }
    const { user, session } = result;`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------

export interface LearnRecord {
  trap: number;
  task: string;
  /** live: a real agent fell into the trap; replayed: it did not, so the careless change was applied */
  mode: 'live' | 'replayed';
  failures: { message: string; anchoredTo: string[]; via: string }[];
  tokens?: number;
}

export interface TransferRun {
  task: string;
  trap: number;
  arm: TransferArm;
  run: number;
  /** The whole suite plus the hidden spec passed (and the agent changed something, unless refusing is allowed) */
  passed: boolean;
  /** A trap test failed on this first attempt. Undefined when it could not be judged (no change, harness error) */
  repeated?: boolean;
  failure?: 'agent-error' | 'no-change' | 'tests' | 'error';
  detail?: string;
  failingTests?: string[];
  tests?: { passed: number; total: number };
  changedFiles: number;
  tokens?: number;
  filesRead?: number;
  durationMs: number;
  promptTokens: number;
}

export interface TransferResults {
  kind: 'transfer';
  generatedAt: string;
  agent: AgentName;
  model: string;
  runsPerArm: number;
  arms: TransferArm[];
  tasks: string[];
  learned: LearnRecord[];
  runs: TransferRun[];
  notes: string[];
}

export interface TransferOptions {
  db: FalkorDB;
  config: PuffConfig;
  adapters: Adapters;
  agent: AgentName;
  source: string;
  runs?: number;
  only?: string[];
  arms?: TransferArm[];
  /** live (default): a real agent tries each learn task first. replay: always apply the careless change */
  learn?: 'live' | 'replay';
  workDir?: string;
  keep?: boolean;
  retries?: number;
  onProgress?: (partial: TransferResults) => Promise<void> | void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Learn by replay and print what each arm would be told; no agent is run */
  dryRun?: boolean;
}

/** Names of the tests that failed, from Vitest output */
export function failingTests(verdict: Verdict, root: string): string[] {
  if (verdict.ok) return [];
  return parseTestFailures(verdict.output, root).map((f) => f.test);
}

/** Did any of these trap tests fail? Matched by name, so "describe > it" headers also match. */
export function hitTrap(failing: string[], trapTests: string[], output = ''): boolean {
  if (failing.some((f) => trapTests.some((t) => f.includes(t)))) return true;
  // fallback: Vitest's own ✗/× lines, in case a header was not recognised
  return trapTests.some((t) => new RegExp(`[×✗✕]\\s.*${escapeRegex(t)}`).test(output));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FLAT_NOTE =
  'READ FIRST: AGENTS.md in the repository root holds lessons from earlier work on this code.';

/** Arm C: every lesson in memory, as a plain file, with nothing chosen for the task. */
export async function renderFlatLessons(graph: Graph): Promise<string> {
  const failures = await read<{ message: string; symbols: string[]; fixes: string[] }>(
    graph,
    `MATCH (f:Failure)-[:IN]->(s:Symbol)
     OPTIONAL MATCH (f)-[:FIXED_BY]->(sol:Solution)
     RETURN f.message AS message, collect(DISTINCT s.id) AS symbols, collect(DISTINCT sol.summary) AS fixes
     ORDER BY message`,
  );
  const decisions = await read<{ text: string; symbols: string[] }>(
    graph,
    `MATCH (d:Decision {status: 'active'})-[:ABOUT]->(s:Symbol)
     RETURN d.text AS text, collect(DISTINCT s.id) AS symbols ORDER BY text`,
  );
  const out = [
    '# Notes from earlier work on this repository',
    '',
    'Lessons the team recorded while working on this code. Read them before you change anything.',
    '',
    '## Mistakes that were made before',
    '',
  ];
  for (const f of failures) {
    out.push(`- ${f.message}`);
    out.push(`  - where: ${f.symbols.join(', ')}`);
    for (const fix of f.fixes.filter(Boolean)) out.push(`  - fixed by: ${fix}`);
  }
  out.push('', '## Decisions to respect', '');
  for (const d of decisions) out.push(`- ${d.text} (${d.symbols.join(', ')})`);
  return `${out.join('\n')}\n`;
}

/** Per arm: runs, how often the mistake was repeated, passes, tokens with their range. */
export function summarizeTransfer(results: TransferResults) {
  const arm = (a: TransferArm) => {
    const all = results.runs.filter((r) => r.arm === a);
    const runs = all.filter((r) => r.failure !== 'agent-error');
    const judged = runs.filter((r) => r.repeated !== undefined);
    const tokens = runs.map((r) => r.tokens).filter((t): t is number => t !== undefined);
    const files = runs.map((r) => r.filesRead).filter((t): t is number => t !== undefined);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0);
    return {
      runs: runs.length,
      invalid: all.length - runs.length,
      judged: judged.length,
      repeated: judged.filter((r) => r.repeated).length,
      repeatRate: judged.length ? judged.filter((r) => r.repeated).length / judged.length : 0,
      passed: runs.filter((r) => r.passed).length,
      passRate: runs.length ? runs.filter((r) => r.passed).length / runs.length : 0,
      noChange: runs.filter((r) => r.failure === 'no-change').length,
      tokens: Math.round(avg(tokens)),
      tokensMin: tokens.length ? Math.min(...tokens) : 0,
      tokensMax: tokens.length ? Math.max(...tokens) : 0,
      filesRead: files.length ? avg(files) : undefined,
      durationMs: Math.round(avg(runs.map((r) => r.durationMs))),
    };
  };
  return Object.fromEntries(results.arms.map((a) => [a, arm(a)])) as Record<
    TransferArm,
    ReturnType<typeof arm>
  >;
}

const identity = ['-c', 'user.name=Puff', '-c', 'user.email=puff@localhost'];

export async function runTransferBenchmark(opts: TransferOptions): Promise<TransferResults> {
  const { db, config, adapters, agent } = opts;
  const log = opts.log ?? (() => {});
  const adapter = adapters[agent];
  if (!adapter) throw new Error(`No adapter for ${agent}`);
  const tasks = TRANSFER_TASKS.filter((t) => !opts.only?.length || opts.only.includes(t.id));
  if (!tasks.length) throw new Error('No transfer task matches');
  const traps = new Set(tasks.map((t) => t.trap));
  const learnTasks = LEARN_TASKS.filter((l) => traps.has(l.trap));
  const arms = opts.arms ?? TRANSFER_ARMS;
  const repeats = opts.runs ?? 1;
  const model = config.harnesses[agent]?.model ?? 'CLI default';

  const work = await mkdtemp(join(opts.workDir ?? tmpdir(), 'puff-transfer-'));
  const slug = `transfer_${Date.now().toString(36)}`;
  const learned: LearnRecord[] = [];
  const runs: TransferRun[] = [];
  const snapshot = (): TransferResults => ({
    kind: 'transfer',
    generatedAt: new Date().toISOString(),
    agent,
    model,
    runsPerArm: repeats,
    arms,
    tasks: tasks.map((t) => t.id),
    learned: [...learned],
    runs: [...runs],
    notes: [
      'One agent and one model for every arm; a fresh copy of the demo repo for every run; one attempt per run.',
      'Memory comes from a learn stage: a real agent tried a tempting task first ("live"); where it did not hit the trap, the recorded careless change was run through the real tests instead ("replayed"). Either way the failure was located and recorded by Puff\'s real code path.',
      'A repeated mistake means a trap test (named per task) failed on the first attempt. Runs with no change or a harness failure are not judged for repeats.',
      'The flat-file arm gets every recorded lesson in AGENTS.md plus one line telling it to read that file; the graph-off arm gets the task and its target files only.',
      'Tokens are input plus output as the harness reported them. Files read is only counted where the harness prints its tool calls (OpenCode).',
      'Small sample: report ranges, and treat differences as indications, not proof.',
    ],
  });

  const run = (prompt: string, cwd: string) =>
    adapter.run({
      prompt,
      cwd,
      role: 'coder',
      timeoutMs: config.limits.timeoutMs,
      model: config.harnesses[agent]?.model,
      signal: opts.signal,
    });

  /** Run, starting over in a clean copy when the harness itself fails */
  const runWithRetries = async (prompt: string, dir: string): Promise<HarnessResult> => {
    let res = await run(prompt, dir);
    for (
      let again = 1;
      res.error && res.error.kind !== 'aborted' && again <= (opts.retries ?? 2);
      again++
    ) {
      log(`  harness problem (${res.error.kind}): ${res.error.message}. Trying again (${again})`);
      await fresh(dir);
      res = await run(prompt, dir);
    }
    return res;
  };
  const fresh = async (dir: string) => {
    await removeLink(join(dir, 'node_modules')).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await setupDemoWorkspace({ source: opts.source, dest: dir });
  };
  const changedFiles = async (dir: string) =>
    (await git(['status', '--porcelain'], dir)).out
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/node_modules/.test(l)).length;
  const verify = (dir: string) =>
    runVerification(dir, config.verify.testCommand, config.limits.timeoutMs, opts.signal);

  try {
    const base = join(work, 'base');
    await setupDemoWorkspace({ source: opts.source, dest: base });
    const project = { slug, name: slug, repoPath: base };
    const graph = await initProjectGraph(db, project, config);
    await indexRepo(graph, project, { graphOff: false });

    // --- Learn ------------------------------------------------------------------------------
    for (const lt of learnTasks) {
      if (opts.signal?.aborted) throw new Error('Stopped');
      const scratch = join(work, `learn-${lt.id}`);
      await setupDemoWorkspace({ source: opts.source, dest: scratch });
      let mode: LearnRecord['mode'] = 'replayed';
      let verdict: Verdict | undefined;
      let tokens: number | undefined;
      if (opts.learn !== 'replay' && !opts.dryRun) {
        log(`learn ${lt.id} (trap ${lt.trap}): a real agent tries it first`);
        const res = await runWithRetries(plainPrompt(lt), scratch);
        tokens = res.tokensIn === undefined ? undefined : res.tokensIn + (res.tokensOut ?? 0);
        if (!res.error && (await changedFiles(scratch)) > 0) {
          await writeAcceptance(scratch, lt);
          const v = await verify(scratch);
          if (hitTrap(failingTests(v, scratch), lt.trapTests, v.output)) {
            mode = 'live';
            verdict = v;
          }
        }
        log(
          mode === 'live'
            ? '  it fell into the trap: recording that run'
            : '  it avoided the trap: replaying the careless change',
        );
      }
      if (mode === 'replayed') {
        await fresh(scratch);
        applyEdits(scratch, lt.lesson.naive);
        await writeAcceptance(scratch, lt);
        verdict = await verify(scratch);
        if (!hitTrap(failingTests(verdict, scratch), lt.trapTests, verdict.output))
          throw new Error(`The careless change for "${lt.id}" did not fail its trap tests`);
      }
      // What the session changed, without the hidden spec (it is the judge, not the session's work)
      const changed = (await git(['status', '--porcelain'], scratch)).out
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/node_modules/.test(l))
        .map((l) => l.slice(3).trim())
        .filter((p) => p !== lt.acceptance.file);
      await git(['add', '-N', '.'], scratch); // so new files show up in the diff
      const diff = (await git(['diff', '--', '.', `:(exclude)${lt.acceptance.file}`], scratch)).out;
      const earlier = await createTask(graph, slug, config, {
        title: `Earlier session: ${lt.title}`,
        type: 'implement',
        complexity: 'medium',
        targets: lt.targets,
      });
      const sessionId = await startSession(graph, { agent, taskId: earlier.id, role: 'coder' });
      const recorded = await recordTestFailures(graph, {
        sessionId,
        taskId: earlier.id,
        output: verdict!.output,
        root: scratch,
        diff,
        changedFiles: changed,
      });
      await finishSession(graph, sessionId, { outcome: 'failure', summary: recorded[0]?.message });
      for (const f of recorded)
        await recordSolution(graph, { failureId: f.id, summary: lt.lesson.fix });
      await recordDecision(graph, {
        symbolIds: await resolveSymbols(graph, lt.lesson.symbols),
        text: lt.lesson.decision,
      });
      await updateTask(graph, earlier.id, { status: 'done' });
      learned.push({
        trap: lt.trap,
        task: lt.id,
        mode,
        tokens,
        failures: recorded.map((r) => ({
          message: r.message,
          anchoredTo: r.symbolIds,
          via: r.via,
        })),
      });
      log(`  recorded ${recorded.length} failure(s) (${mode})`);
      await opts.onProgress?.(snapshot());
    }
    // risk and open failures, as they are after the learn stage
    await indexRepo(graph, project, { graphOff: false });
    const flat = await renderFlatLessons(graph);

    const taskIds = new Map<string, string>();
    for (const t of tasks) {
      const created = await createTask(graph, slug, config, {
        title: t.title,
        type: 'implement',
        complexity: 'medium',
        targets: t.targets,
      });
      taskIds.set(t.id, created.id);
    }

    // --- Transfer -----------------------------------------------------------------------------
    for (const task of tasks) {
      for (let n = 1; n <= repeats; n++) {
        // rotate the arm order so slow drift (provider load) does not favour one arm
        const shift = (n + task.trap) % arms.length;
        const order = [...arms.slice(shift), ...arms.slice(0, shift)];
        for (const arm of order) {
          if (opts.signal?.aborted) throw new Error('Stopped');
          log(`${task.id} · ${arm} · run ${n}`);
          const dir = join(work, `${task.id}-${arm}-${n}`);
          await setupDemoWorkspace({ source: opts.source, dest: dir });
          if (arm === 'flat') {
            await writeFile(join(dir, 'AGENTS.md'), flat);
            await git(['add', 'AGENTS.md'], dir);
            await git([...identity, 'commit', '-q', '-m', 'notes from earlier work'], dir);
          }
          const prompt =
            arm === 'none'
              ? plainPrompt(task)
              : arm === 'flat'
                ? `${plainPrompt(task)}\n\n${FLAT_NOTE}`
                : (
                    await compileContext(graph, taskIds.get(task.id)!, {
                      role: 'coder',
                      preview: true,
                      budgetTokens: config.limits.contextTokenBudget,
                      testCommand: config.verify.testCommand,
                      graphOff: arm === 'graph-off',
                      riskThreshold: config.graph.riskThreshold,
                    })
                  ).prompt;

          if (opts.dryRun) {
            log(`----- ${task.id} · ${arm} (~${estimateTokens(prompt)} tokens) -----
${prompt}
`);
            continue;
          }
          const res = await runWithRetries(prompt, dir);
          const changed = await changedFiles(dir);
          const basics = {
            task: task.id,
            trap: task.trap,
            arm,
            run: n,
            changedFiles: changed,
            tokens: res.tokensIn === undefined ? undefined : res.tokensIn + (res.tokensOut ?? 0),
            filesRead: res.filesRead,
            durationMs: res.durationMs,
            promptTokens: estimateTokens(prompt),
          };
          let result: TransferRun;
          if (res.error) {
            result = {
              ...basics,
              passed: false,
              failure: 'agent-error',
              detail: `${res.error.kind}: ${res.error.message}`,
            };
          } else if (changed === 0 && !task.noChangeOk) {
            result = {
              ...basics,
              passed: false,
              failure: 'no-change',
              detail: 'The agent changed no files',
            };
          } else {
            await writeAcceptance(dir, task);
            const v = await verify(dir);
            const failing = failingTests(v, dir);
            const tests = v.summary && { passed: v.summary.passed, total: v.summary.total };
            const repeated =
              v.kind === 'tests-failed'
                ? hitTrap(failing, task.trapTests, v.output)
                : v.ok
                  ? false
                  : undefined;
            result = v.ok
              ? { ...basics, passed: true, repeated: false, tests }
              : {
                  ...basics,
                  passed: false,
                  repeated,
                  failure: v.kind === 'tests-failed' ? 'tests' : 'error',
                  failingTests: failing.slice(0, 8),
                  tests,
                  detail: v.message ?? 'Tests failed',
                };
          }
          runs.push(result);
          await opts.onProgress?.(snapshot());
          log(
            `  ${result.passed ? '✔ passed' : `✖ ${result.failure}`}${result.repeated ? ' · REPEATED the mistake' : ''} · ${result.tokens ?? '?'} tokens · ${Math.round(result.durationMs / 1000)}s`,
          );
        }
      }
    }
  } finally {
    await projectGraph(db, slug)
      .delete()
      .catch(() => {});
    if (!opts.keep) {
      for (const entry of await readdir(work).catch(() => [] as string[])) {
        const nm = join(work, entry, 'node_modules');
        if (existsSync(nm)) await removeLink(nm).catch(() => {});
      }
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) =>
        log(`could not remove ${work}: ${(e as Error).message}`),
      );
    }
  }
  return snapshot();
}

/** Read a transfer result file; undefined when there is none or it is something else. */
export async function loadTransferResults(path: string): Promise<TransferResults | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TransferResults>;
    return parsed.kind === 'transfer' && Array.isArray(parsed.runs)
      ? (parsed as TransferResults)
      : undefined;
  } catch {
    return undefined;
  }
}
