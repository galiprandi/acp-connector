/**
 * Minimal level-filtered logger. Zero dependencies.
 * Levels: error(0) < warn(1) < info(2) < debug(3).
 * `error` always prints; everything else is filtered by the configured level.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = ORDER.info;

export function setLogLevel(level: LogLevel | undefined): void {
  currentLevel = ORDER[level ?? 'info'] ?? ORDER.info;
}

/**
 * Human-readable error string that includes the underlying `cause`
 * (e.g. undici's `fetch failed` hides the real reason there).
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    const suffix = code ? ` [${code}]` : '';
    return `${err.message}: ${cause.message}${suffix}`;
  }
  if (cause) return `${err.message}: ${String(cause)}`;
  return err.message;
}

export const log = {
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
  warn: (...args: unknown[]): void => {
    if (currentLevel >= ORDER.warn) console.warn(...args);
  },
  info: (...args: unknown[]): void => {
    if (currentLevel >= ORDER.info) console.log(...args);
  },
  debug: (...args: unknown[]): void => {
    if (currentLevel >= ORDER.debug) console.log(...args);
  },
};
