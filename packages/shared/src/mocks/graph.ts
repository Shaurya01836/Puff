// Mock project graph for demo/shop-api: code graph + memory, built from a compact description.
import type { GraphData, GraphEdge, GraphNode } from '../types';
import { mockSessions, mockTasks } from './fixtures';

/** file path -> symbols it defines (`Class.method` for methods) */
const files: Record<string, string[]> = {
  'src/auth/login.ts': ['login', 'hashPassword', 'checkUser'],
  'src/auth/session.ts': ['Session', 'Session.start', 'Session.end'],
  'src/auth/tokens.ts': ['issueToken', 'verifyToken'],
  'src/auth/audit.ts': ['audit', 'redact'],
  'src/middleware/rateLimit.ts': ['rateLimit', 'resetBucket'],
  'src/middleware/requireAuth.ts': ['requireAuth'],
  'src/routes/auth.ts': ['postLogin', 'postLogout'],
  'src/routes/cart.ts': ['getCart', 'postCartItem'],
  'src/cart/cart.ts': ['addItem', 'removeItem', 'cartTotal', 'applyDiscount'],
  'src/products/products.ts': ['findProduct', 'listProducts'],
  'src/users/users.ts': ['findUser', 'createUser'],
  'src/lib/logger.ts': ['log'],
  'src/lib/db.ts': ['query'],
  'test/auth.spec.ts': [],
};

const sym = (file: string, name: string) => `${file}::${name}`;
const S = {
  login: sym('src/auth/login.ts', 'login'),
  hashPassword: sym('src/auth/login.ts', 'hashPassword'),
  checkUser: sym('src/auth/login.ts', 'checkUser'),
  sessionStart: sym('src/auth/session.ts', 'Session.start'),
  sessionEnd: sym('src/auth/session.ts', 'Session.end'),
  issueToken: sym('src/auth/tokens.ts', 'issueToken'),
  verifyToken: sym('src/auth/tokens.ts', 'verifyToken'),
  audit: sym('src/auth/audit.ts', 'audit'),
  redact: sym('src/auth/audit.ts', 'redact'),
  rateLimit: sym('src/middleware/rateLimit.ts', 'rateLimit'),
  resetBucket: sym('src/middleware/rateLimit.ts', 'resetBucket'),
  requireAuth: sym('src/middleware/requireAuth.ts', 'requireAuth'),
  postLogin: sym('src/routes/auth.ts', 'postLogin'),
  postLogout: sym('src/routes/auth.ts', 'postLogout'),
  getCart: sym('src/routes/cart.ts', 'getCart'),
  postCartItem: sym('src/routes/cart.ts', 'postCartItem'),
  addItem: sym('src/cart/cart.ts', 'addItem'),
  removeItem: sym('src/cart/cart.ts', 'removeItem'),
  cartTotal: sym('src/cart/cart.ts', 'cartTotal'),
  applyDiscount: sym('src/cart/cart.ts', 'applyDiscount'),
  findProduct: sym('src/products/products.ts', 'findProduct'),
  listProducts: sym('src/products/products.ts', 'listProducts'),
  findUser: sym('src/users/users.ts', 'findUser'),
  createUser: sym('src/users/users.ts', 'createUser'),
  log: sym('src/lib/logger.ts', 'log'),
  query: sym('src/lib/db.ts', 'query'),
};

const calls: [string, string][] = [
  [S.postLogin, S.rateLimit],
  [S.postLogin, S.login],
  [S.login, S.checkUser],
  [S.login, S.hashPassword],
  [S.login, S.audit],
  [S.login, S.sessionStart],
  [S.checkUser, S.findUser],
  [S.audit, S.redact],
  [S.audit, S.log],
  [S.sessionStart, S.issueToken],
  [S.postLogout, S.sessionEnd],
  [S.requireAuth, S.verifyToken],
  [S.rateLimit, S.resetBucket],
  [S.getCart, S.requireAuth],
  [S.getCart, S.cartTotal],
  [S.postCartItem, S.requireAuth],
  [S.postCartItem, S.addItem],
  [S.addItem, S.findProduct],
  [S.cartTotal, S.applyDiscount],
  [S.findProduct, S.query],
  [S.listProducts, S.query],
  [S.findUser, S.query],
  [S.createUser, S.hashPassword],
  [S.createUser, S.query],
];

const imports: [string, string][] = [
  ['src/routes/auth.ts', 'src/auth/login.ts'],
  ['src/routes/auth.ts', 'src/middleware/rateLimit.ts'],
  ['src/routes/auth.ts', 'src/auth/session.ts'],
  ['src/auth/login.ts', 'src/auth/audit.ts'],
  ['src/auth/login.ts', 'src/users/users.ts'],
  ['src/auth/login.ts', 'src/auth/session.ts'],
  ['src/auth/session.ts', 'src/auth/tokens.ts'],
  ['src/auth/audit.ts', 'src/lib/logger.ts'],
  ['src/routes/cart.ts', 'src/cart/cart.ts'],
  ['src/routes/cart.ts', 'src/middleware/requireAuth.ts'],
  ['src/cart/cart.ts', 'src/products/products.ts'],
  ['src/products/products.ts', 'src/lib/db.ts'],
  ['src/users/users.ts', 'src/lib/db.ts'],
  ['test/auth.spec.ts', 'src/auth/login.ts'],
  ['test/auth.spec.ts', 'src/auth/tokens.ts'],
];

const memory: GraphNode[] = [
  {
    id: 'fail_01',
    label: 'password appears in audit log',
    kind: 'Failure',
    props: { kind: 'test', stale: false },
  },
  {
    id: 'fail_02',
    label: 'expired token accepted (s vs ms)',
    kind: 'Failure',
    props: { kind: 'test', stale: false },
  },
  {
    id: 'fail_03',
    label: 'discount applied before tax',
    kind: 'Failure',
    props: { kind: 'test', stale: false },
  },
  { id: 'sol_01', label: 'redact credentials before audit()', kind: 'Solution' },
  { id: 'sol_02', label: 'normalise expiry to ms', kind: 'Solution' },
  {
    id: 'dec_00',
    label: 'tokens in localStorage',
    kind: 'Decision',
    props: { status: 'superseded' },
  },
  {
    id: 'dec_01',
    label: 'tokens in httpOnly cookies',
    kind: 'Decision',
    props: { status: 'active' },
  },
  {
    id: 'dec_02',
    label: 'rate limit per IP, 5 / 60 s',
    kind: 'Decision',
    props: { status: 'active', stale: true },
  },
  {
    id: 'dec_03',
    label: 'discounts apply after tax',
    kind: 'Decision',
    props: { status: 'active' },
  },
  { id: 'proc_01', label: 'npm test -- auth', kind: 'Procedure' },
  { id: 'proc_02', label: 'never log request bodies', kind: 'Procedure' },
  { id: 'tech:express', label: 'Express', kind: 'Technology' },
  { id: 'tech:jest', label: 'Jest', kind: 'Technology' },
  { id: 'tech:typescript', label: 'TypeScript', kind: 'Technology' },
  { id: 'agent:claude-code', label: 'claude-code', kind: 'Agent' },
  { id: 'agent:codex', label: 'codex', kind: 'Agent' },
  { id: 'agent:opencode', label: 'opencode', kind: 'Agent' },
];

const memoryEdges: GraphEdge[] = [
  { source: 'ses_03', target: 'fail_01', type: 'HIT' },
  { source: 'fail_01', target: S.login, type: 'IN' },
  { source: 'fail_01', target: 'sol_01', type: 'FIXED_BY' },
  { source: 'ses_04', target: 'fail_02', type: 'HIT' },
  { source: 'fail_02', target: S.verifyToken, type: 'IN' },
  { source: 'fail_02', target: 'sol_02', type: 'FIXED_BY' },
  { source: 'ses_06', target: 'fail_03', type: 'HIT' },
  { source: 'fail_03', target: S.cartTotal, type: 'IN' },
  { source: 'dec_01', target: 'dec_00', type: 'SUPERSEDES' },
  { source: 'dec_01', target: S.sessionStart, type: 'ABOUT' },
  { source: 'dec_00', target: S.sessionStart, type: 'ABOUT' },
  { source: 'dec_02', target: S.rateLimit, type: 'ABOUT' },
  { source: 'dec_03', target: S.applyDiscount, type: 'ABOUT' },
  { source: 'proc_01', target: 'tech:jest', type: 'APPLIES_TO' },
  { source: 'proc_02', target: 'tech:express', type: 'APPLIES_TO' },
];

function buildGraph(): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [path, names] of Object.entries(files)) {
    nodes.push({ id: path, label: path.split('/').pop() ?? path, kind: 'File', props: { path } });
    edges.push({ source: path, target: 'tech:typescript', type: 'USES' });
    if (path.startsWith('test/')) edges.push({ source: path, target: 'tech:jest', type: 'USES' });
    if (path.startsWith('src/routes') || path.startsWith('src/middleware')) {
      edges.push({ source: path, target: 'tech:express', type: 'USES' });
    }
    for (const name of names) {
      const kind = name.includes('.') ? 'Method' : /^[A-Z]/.test(name) ? 'Class' : 'Function';
      nodes.push({
        id: sym(path, name),
        label: name,
        kind: 'Symbol',
        props: { file: path, symbolKind: kind },
      });
      edges.push({ source: path, target: sym(path, name), type: 'DEFINES' });
    }
  }
  for (const [source, target] of calls) edges.push({ source, target, type: 'CALLS' });
  for (const [source, target] of imports) edges.push({ source, target, type: 'IMPORTS' });

  for (const t of mockTasks) {
    nodes.push({
      id: t.id,
      label: t.title,
      kind: 'Task',
      props: { status: t.status, type: t.type },
    });
    for (const target of t.targets) edges.push({ source: t.id, target, type: 'TARGETS' });
    for (const dep of t.dependsOn) edges.push({ source: t.id, target: dep, type: 'DEPENDS_ON' });
  }
  for (const s of mockSessions) {
    nodes.push({
      id: s.id,
      label: `${s.agent} · ${s.outcome}`,
      kind: 'Session',
      props: { outcome: s.outcome },
    });
    edges.push({ source: `agent:${s.agent}`, target: s.id, type: 'RAN' });
    edges.push({ source: s.id, target: s.taskId, type: 'WORKED_ON' });
  }

  nodes.push(...memory);
  edges.push(...memoryEdges);
  return { nodes, edges };
}

export const mockGraph: GraphData = buildGraph();

export { neighbourhood } from '../graph';
