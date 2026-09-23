/** The SDK only ever logs; it never throws into user code. Warnings are rate limited per key. */
const last = new Map<string, number>();

export function warnLimited(key: string, message: string, intervalMs = 30_000): void {
  const now = Date.now();
  const prev = last.get(key);
  if (prev !== undefined && now - prev < intervalMs) return;
  last.set(key, now);
  console.warn(`agentspace: ${message}`);
}

export function internalError(where: string, err: unknown): void {
  warnLimited(`internal:${where}`, `internal error in ${where} (ignored, your app is unaffected): ${String(err)}`);
}
