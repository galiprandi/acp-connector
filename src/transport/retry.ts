import { ok, type Result, type TransportError } from './types.js';

export interface RetryOpts {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay in ms — doubles each retry with jitter. Default 500. */
  baseDelayMs?: number;
  /** Cap on computed delay. Default 15000. */
  maxDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const retryable = (e: TransportError): boolean => e.kind === 'network' || e.kind === 'rate_limited';

/**
 * Run `fn` (which returns a Result) retrying transient failures with
 * exponential backoff + jitter. `rate_limited` waits at least
 * `retryAfterMs`. `api`/`fatal` return immediately — they're permanent.
 */
export async function withRetry<T>(
  fn: () => Promise<Result<T>>,
  opts: RetryOpts = {}
): Promise<Result<T>> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 15000;
  let last: Result<T> = [{ kind: 'api', message: 'no attempts' }, null];
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    const e = last[0];
    if (!e || !retryable(e) || i === attempts - 1) return last;
    const backoff = Math.min(e.retryAfterMs ?? base * 2 ** i, max);
    await sleep(backoff * (0.5 + Math.random() * 0.5));
  }
  return last;
}

/** Wrap a throwing call into a Result using `map` for classification. */
export async function tryC<T>(
  fn: () => Promise<T>,
  map: (e: unknown) => TransportError
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return [map(e), null];
  }
}
