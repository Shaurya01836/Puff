import request from 'supertest';
import { createApp } from '../src/app';
import { resetDb } from '../src/lib/db';
import { clearLog } from '../src/lib/logger';
import { DEMO_USER, seedDemoData } from '../src/seed';

export function resetAll(): void {
  resetDb();
  clearLog();
  seedDemoData();
}

/** A supertest agent that keeps cookies, already signed in as the demo user. */
export async function signedInAgent() {
  const agent = request.agent(createApp());
  await agent
    .post('/auth/login')
    .send({ email: DEMO_USER.email, password: DEMO_USER.password })
    .expect(200);
  return agent;
}
