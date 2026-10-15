import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, findUserByEmail } from '../src/users/users';
import { resetAll, signedInAgent } from './helpers';

beforeEach(resetAll);

describe('users', () => {
  it('creates a user without exposing the password hash', () => {
    const user = createUser({ email: 'New@Shop.test', password: 'long-enough-1', name: ' Ada ' });
    expect(user).toEqual({ id: expect.any(String), email: 'new@shop.test', name: 'Ada' });
    expect(findUserByEmail('new@shop.test')?.passwordHash).not.toContain('long-enough-1');
  });

  it('validates input', () => {
    expect(() => createUser({ email: 'nope', password: 'long-enough-1', name: 'A' })).toThrow(
      /email/,
    );
    expect(() => createUser({ email: 'a@b.co', password: 'short', name: 'A' })).toThrow(
      /8 characters/,
    );
    expect(() =>
      createUser({ email: 'demo@shop.test', password: 'long-enough-1', name: 'A' }),
    ).toThrow(/already registered/);
  });

  it('returns the signed-in user from /users/me', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/users/me').expect(200);
    expect(res.body.user.email).toBe('demo@shop.test');
  });
});
