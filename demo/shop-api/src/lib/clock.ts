/** Current time in milliseconds. Wrapped so tests can control time. */
export function now(): number {
  return Date.now();
}

/** Current time in whole seconds. */
export function nowSeconds(): number {
  return Math.floor(now() / 1000);
}
