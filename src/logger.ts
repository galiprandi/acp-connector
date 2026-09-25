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
