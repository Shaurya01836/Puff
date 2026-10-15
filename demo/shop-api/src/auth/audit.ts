import { log } from '../lib/logger';

/** Security-relevant events (logins, logouts, orders) go to the audit log. */
export function audit(event: string, details: Record<string, unknown>): void {
  log('info', `audit:${event}`, details);
}
