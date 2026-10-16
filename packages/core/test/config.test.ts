import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allCapabilities, parseConfig } from '../src/config';
import { graphName, newId, slugify, symbolId } from '../src/ids';

const repoConfig = readFileSync(
  fileURLToPath(new URL('../../../puff.config.yaml', import.meta.url)),
  'utf8',
);

describe('config', () => {
  it('parses the repo puff.config.yaml', () => {
    const config = parseConfig(repoConfig);
    expect(Object.keys(config.harnesses)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(config.harnesses['codex']?.promptVia).toBe('stdin');
    expect(config.limits.maxParallel).toBe(3);
    expect(config.escalation).toEqual(['opencode', 'codex', 'claude-code']);
  });

  it('fills defaults for optional sections', () => {
    const config = parseConfig(`
harnesses:
  codex: { command: codex }
routing:
  implement: [implementation]
`);
    expect(config.harnesses['codex']).toMatchObject({ args: [], promptVia: 'stdin', instances: 1 });
    expect(config.limits).toEqual({
      maxParallel: 3,
      timeoutMs: 600_000,
      retriesBeforeEscalate: 1,
      maxAttempts: 3,
      maxTasksPerPlan: 8,
      maxSpawnDepth: 2,
      contextTokenBudget: 2000,
      stallWarnMs: 180_000,
      stallKillMs: 0, // an agent is only warned about by default, never stopped for being quiet
    });
    expect(config.worktrees.linkDirs).toEqual(['node_modules']);
  });

  it('rejects escalation to an unknown harness', () => {
    expect(() =>
      parseConfig(`
harnesses:
  codex: { command: codex }
routing: {}
escalation: [codex, antigravity]
`),
    ).toThrow(/unknown harness.*antigravity/);
  });

  it('collects capabilities from strengths and routing', () => {
    const caps = allCapabilities(parseConfig(repoConfig));
    expect(caps).toContain('implementation');
    expect(caps).toContain('docs');
    expect(new Set(caps).size).toBe(caps.length);
  });
});

describe('ids', () => {
  it('prefixes ids by kind', () => {
    expect(newId('Failure')).toMatch(/^fail_[0-9A-Z]{26}$/);
    expect(newId('Session')).toMatch(/^ses_/);
  });

  it('builds stable symbol ids', () => {
    expect(symbolId('src/auth/login.ts', 'Session.start')).toBe('src/auth/login.ts::Session.start');
  });

  it('slugifies project names into graph names', () => {
    expect(slugify('Shop API')).toBe('shop_api');
    expect(slugify('--demo/shop-api--')).toBe('demo_shop_api');
    expect(graphName(slugify('shop-api'))).toBe('puff_shop_api');
    expect(() => slugify('!!!')).toThrow();
  });
});
