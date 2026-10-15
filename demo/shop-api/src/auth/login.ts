import { unauthorized } from '../lib/errors';
import { findUserByEmail, publicUser, type PublicUser, type UserRow } from '../users/users';
import { audit } from './audit';
import { verifyPassword } from './password';
import { Session } from './session';

export interface LoginResult {
  user: PublicUser;
  session: Session;
}

export function login(email: string, password: string): LoginResult {
  const user = checkUser(email, password);
  const session = Session.start(user.id);
  audit('login.success', { userId: user.id, email: user.email });
  return { user: publicUser(user), session };
}

export function checkUser(email: string, password: string): UserRow {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    audit('login.failed', { email });
    throw unauthorized('Invalid email or password');
  }
  return user;
}
