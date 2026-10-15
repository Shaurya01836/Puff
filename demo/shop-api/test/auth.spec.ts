import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { login } from '../src/auth/login';
import { logEntries } from '../src/lib/logger';
import { DEMO_USER } from '../src/seed';
import { resetAll } from './helpers';

beforeEach(resetAll);

describe('login', () => {
  it('signs in with the right password', () => {
    const { user, session } = login(DEMO_USER.email, DEMO_USER.password);
    expect(user.email).toBe(DEMO_USER.email);
    expect(session.token).toContain('.');
  });

  it('rejects a wrong password with 401', () => {
    expect(() => login(DEMO_USER.email, 'nope-nope-nope')).toThrow(/Invalid email or password/);
  });

  it('never writes a password to the logs', () => {
    login(DEMO_USER.email, DEMO_USER.password);
    expect(() => login(DEMO_USER.email, 'wrong-password-123')).toThrow();
    const logged = JSON.stringify(logEntries());
    expect(logged).not.toContain(DEMO_USER.password);
    expect(logged).not.toContain('wrong-password-123');
  });

  it('records successful and failed logins in the audit log', () => {
    login(DEMO_USER.email, DEMO_USER.password);
    expect(() => login(DEMO_USER.email, 'wrong-password-123')).toThrow();
    const events = logEntries().map((e) => e.message);
    expect(events).toContain('audit:login.success');
    expect(events).toContain('audit:login.failed');
  });
});

describe('POST /auth/login', () => {
  it('sets an httpOnly session cookie and never returns the token in the body', async () => {
    const res = await request(createApp())
      .post('/auth/login')
      .send({ email: DEMO_USER.email, password: DEMO_USER.password })
      .expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('returns 401 for bad credentials', async () => {
    await request(createApp())
      .post('/auth/login')
      .send({ email: DEMO_USER.email, password: 'bad-password-1' })
      .expect(401);
  });
});
