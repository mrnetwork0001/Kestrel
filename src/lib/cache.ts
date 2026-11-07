import { kvGetJson, kvSetJson } from "@/lib/kv";

const g = globalThis as typeof globalThis & { __kestrelInflight?: Map<string, Promise<unknown>> };
const inflight = (g.__kestrelInflight ??= new Map());

/**
 * Read-through cache on the shared KV (JSON, `ttlSec` expiry). Concurrent identical calls in this process
 * share one in-flight computation. Errors from `fn` propagate and are never cached. Values must be plain
 * JSON (engine results carry uint256s as decimal strings); a value containing a bigint is returned
 * uncached rather than silently coerced, so cached and fresh responses always have the same shape.
 */
export function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const ck = `cache:${key}`;
  const pending = inflight.get(ck);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    const hit = await kvGetJson<T>(ck);
    if (hit !== null) return hit;
    const value = await fn();
    try {
      await kvSetJson(ck, value, { ex: ttlSec });
    } catch (e) {
      console.warn(`[cache] not stored ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return value;
  })().finally(() => inflight.delete(ck));
  inflight.set(ck, p);
  return p;
}
