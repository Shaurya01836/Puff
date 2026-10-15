import { hashPassword } from '../auth/password';
import { findById, insert, query } from '../lib/db';
import { conflict } from '../lib/errors';
import { newId } from '../lib/ids';
import { validateEmail, validateName, validatePassword } from './validate';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

export type PublicUser = Omit<UserRow, 'passwordHash'>;

export function createUser(input: {
  email: unknown;
  password: unknown;
  name: unknown;
}): PublicUser {
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const name = validateName(input.name);
  if (findUserByEmail(email)) throw conflict('Email already registered');
  const user = insert<UserRow>('users', {
    id: newId('usr'),
    email,
    name,
    passwordHash: hashPassword(password),
  });
  return publicUser(user);
}

export function findUserByEmail(email: string): UserRow | undefined {
  return query<UserRow>('users', { email: email.toLowerCase() })[0];
}

export function findUserById(id: string): UserRow | undefined {
  return findById<UserRow>('users', id);
}

export function publicUser({ passwordHash: _hash, ...user }: UserRow): PublicUser {
  return user;
}
