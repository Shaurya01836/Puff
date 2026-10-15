import { badRequest } from '../lib/errors';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: unknown): string {
  if (typeof email !== 'string' || !EMAIL.test(email))
    throw badRequest('A valid email is required');
  return email.toLowerCase();
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }
  return password;
}

export function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw badRequest('Name is required');
  return name.trim();
}
