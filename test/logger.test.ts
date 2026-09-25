import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, setLogLevel } from '../src/logger.js';

describe('logger', () => {
  afterEach(() => {
    setLogLevel('info');
    vi.restoreAllMocks();
  });

  it('defaults to info level (log + warn + error, no debug)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel(undefined);
    log.info('a');
    log.warn('b');
    log.error('c');
    log.debug('d');
    expect(logSpy).toHaveBeenCalledWith('a');
    expect(warnSpy).toHaveBeenCalledWith('b');
    expect(errSpy).toHaveBeenCalledWith('c');
    expect(logSpy).not.toHaveBeenCalledWith('d');
  });

  it('error level only prints errors', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel('error');
    log.info('a');
    log.warn('b');
    log.error('c');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('c');
  });

  it('debug level prints everything', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setLogLevel('debug');
    log.info('a');
    log.debug('b');
    expect(logSpy).toHaveBeenCalledWith('a');
    expect(logSpy).toHaveBeenCalledWith('b');
  });

  it('unknown level falls back to info', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid runtime value
    setLogLevel('bogus' as any);
    log.info('a');
    log.debug('b');
    expect(logSpy).toHaveBeenCalledWith('a');
    expect(logSpy).not.toHaveBeenCalledWith('b');
  });
});
