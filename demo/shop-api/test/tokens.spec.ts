import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '../src/auth/tokens';

describe('tokens', () => {
  it('round-trips a user id', () => {
    expect(verifyToken(issueToken('usr_1'))).toBe('usr_1');
  });

  it('rejects a tampered token', () => {
    const [body, sig] = issueToken('usr_1').split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'usr_admin', exp: 9e15 })).toString(
      'base64url',
    );
    expect(verifyToken(`${forged}.${sig}`)).toBeUndefined();
    expect(verifyToken(`${body}.not-a-signature`)).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(verifyToken('')).toBeUndefined();
    expect(verifyToken('a.b.c')).toBeUndefined();
  });
});
