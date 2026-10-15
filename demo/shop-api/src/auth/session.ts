import { insert, query, update } from '../lib/db';
import { now } from '../lib/clock';
import { newId } from '../lib/ids';
import { audit } from './audit';
import { issueToken, verifyToken } from './tokens';

export interface SessionRow {
  id: string;
  userId: string;
  token: string;
  startedAt: number;
  endedAt?: number;
}

export class Session {
  private constructor(private readonly row: SessionRow) {}

  static start(userId: string): Session {
    const row = insert<SessionRow>('sessions', {
      id: newId('ses'),
      userId,
      token: issueToken(userId),
      startedAt: now(),
    });
    return new Session(row);
  }

  static fromRow(row: SessionRow): Session {
    return new Session(row);
  }

  get id(): string {
    return this.row.id;
  }

  get token(): string {
    return this.row.token;
  }

  get userId(): string {
    return this.row.userId;
  }

  end(): void {
    update<SessionRow>('sessions', this.row.id, { endedAt: now() });
    audit('logout', { userId: this.row.userId, sessionId: this.row.id });
  }
}

/** Resolve the open session behind a cookie token, if the token is valid. */
export function findSession(token: string): Session | undefined {
  if (!verifyToken(token)) return undefined;
  const row = query<SessionRow>('sessions', { token })[0];
  return row && !row.endedAt ? Session.fromRow(row) : undefined;
}
