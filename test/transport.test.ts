import { describe, expect, it, vi } from 'vitest';
import { mapDiscordError } from '../src/transport/discord';
import { tryC, withRetry } from '../src/transport/retry';
import {
  mapTelegramError,
  normalizeCallback,
  normalizeMessage,
  type TelegramLike,
  TelegramTransport,
} from '../src/transport/telegram';
import type { Result, TransportError } from '../src/transport/types';

const apiErr = (message: string): Result<never> => [{ kind: 'api', message }, null];
const netErr = (message: string): Result<never> => [{ kind: 'network', message }, null];
const fatalErr = (message: string): Result<never> => [{ kind: 'fatal', message }, null];

describe('withRetry', () => {
  it('returns first success without retrying', async () => {
    const fn = vi.fn(async (): Promise<Result<number>> => [null, 42]);
    const [e, data] = await withRetry(fn);
    expect(e).toBeNull();
    expect(data).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry api errors', async () => {
    const fn = vi.fn(async () => apiErr('bad request'));
    const [e] = await withRetry(fn);
    expect(e?.kind).toBe('api');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry fatal errors', async () => {
    const fn = vi.fn(async () => fatalErr('unauthorized'));
    const [e] = await withRetry(fn);
    expect(e?.kind).toBe('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors up to the attempt cap', async () => {
    const fn = vi.fn(async () => netErr('ECONNRESET'));
    const [e] = await withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    expect(e?.kind).toBe('network');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('succeeds on a later attempt after transient failures', async () => {
    let n = 0;
    const fn = vi.fn(async (): Promise<Result<string>> => {
      n += 1;
      return n < 3 ? netErr('timeout') : [null, 'ok'];
    });
    const [e, data] = await withRetry(fn, { attempts: 5, baseDelayMs: 1, maxDelayMs: 5 });
    expect(e).toBeNull();
    expect(data).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits at least retryAfterMs for rate_limited errors', async () => {
    const sleeps: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test stub of setTimeout
      ((cb: () => void, ms?: number): any => {
        sleeps.push(ms ?? 0);
        return origSetTimeout(cb, 0);
      }) as typeof setTimeout
    );
    const fn = vi
      .fn()
      .mockResolvedValueOnce([{ kind: 'rate_limited', message: '429', retryAfterMs: 2000 }, null])
      .mockResolvedValueOnce([null, 'done']);
    const [, data] = await withRetry(fn);
    expect(data).toBe('done');
    // jittered 50–100% of 2000 → between 1000 and 2000
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
    vi.restoreAllMocks();
  });
});

describe('tryC', () => {
  it('wraps resolution into [null, data]', async () => {
    const [e, d] = await tryC(
      async () => 7,
      () => apiErr('x')
    );
    expect(e).toBeNull();
    expect(d).toBe(7);
  });

  it('maps rejections through the classifier', async () => {
    const [e] = await tryC(
      async () => {
        throw new Error('kaboom');
      },
      (): TransportError => ({ kind: 'fatal', message: 'mapped' })
    );
    expect(e?.kind).toBe('fatal');
    expect(e?.message).toBe('mapped');
  });
});

describe('mapTelegramError', () => {
  it('maps fetch/AggregateError failures to network', () => {
    expect(mapTelegramError(new Error('fetch failed')).kind).toBe('network');
    expect(mapTelegramError(new Error('AggregateError')).kind).toBe('network');
    expect(mapTelegramError(new Error('read ECONNRESET')).kind).toBe('network');
  });

  it('maps unknown errors to api', () => {
    expect(mapTelegramError(new Error('something weird')).kind).toBe('api');
    expect(mapTelegramError('plain string').kind).toBe('api');
  });

  it('maps TelegramApiError by status', async () => {
    const { TelegramApiError } = await import('node-telegram-bot-api');
    const make = (code: number, retryAfter?: number) => {
      const err = Object.create(TelegramApiError.prototype);
      for (const [k, v] of Object.entries({
        errorCode: code,
        retryAfter,
        name: 'TelegramApiError',
      })) {
        Object.defineProperty(err, k, { value: v, configurable: true });
      }
      err.message = `TG ${code}`;
      return err as InstanceType<typeof TelegramApiError>;
    };
    expect(mapTelegramError(make(429, 3))).toEqual({
      kind: 'rate_limited',
      message: 'TG 429',
      retryAfterMs: 3000,
      code: 429,
    });
    expect(mapTelegramError(make(500)).kind).toBe('network');
    expect(mapTelegramError(make(401)).kind).toBe('fatal');
    expect(mapTelegramError(make(400)).kind).toBe('api');
  });
});

describe('normalizeMessage', () => {
  // biome-ignore lint/suspicious/noExplicitAny: partial Bot API payloads
  const msg = (o: any) => normalizeMessage(o);

  it('normalizes a private text message', () => {
    const m = msg({
      chat: { id: 123, type: 'private' },
      message_id: 7,
      text: 'hi',
      from: { id: 9, first_name: 'Ana', last_name: 'Lee', username: 'analee' },
    });
    expect(m.chatId).toBe(123);
    expect(m.chatType).toBe('private');
    expect(m.messageId).toBe(7);
    expect(m.text).toBe('hi');
    expect(m.sender).toEqual({ id: 9, name: 'Ana Lee', username: 'analee' });
  });

  it('exposes username when names are missing (domain applies the @ fallback)', () => {
    const m = msg({
      chat: { id: 1, type: 'private' },
      message_id: 1,
      text: 'x',
      from: { id: 2, username: 'solo' },
    });
    expect(m.sender?.name).toBeUndefined();
    expect(m.sender?.username).toBe('solo');
  });

  it('normalizes group title and reply context', () => {
    const m = msg({
      chat: { id: -100, type: 'supergroup', title: 'Familia' },
      message_id: 3,
      text: 'ok',
      reply_to_message: { text: 'earlier', from: { username: 'gali' } },
    });
    expect(m.chatTitle).toBe('Familia');
    expect(m.replyTo).toEqual({ author: '@gali', text: 'earlier' });
  });

  it('normalizes photo media picking the largest size', () => {
    const m = msg({
      chat: { id: 1, type: 'private' },
      message_id: 1,
      photo: [{ file_id: 'small' }, { file_id: 'big' }],
      caption: 'look',
    });
    expect(m.media).toEqual({
      kind: 'photo',
      fileId: 'big',
      fileName: undefined,
      mimeType: 'image/jpeg',
    });
    expect(m.caption).toBe('look');
  });

  it('normalizes voice and document media', () => {
    const v = msg({
      chat: { id: 1, type: 'private' },
      message_id: 1,
      voice: { file_id: 'v1', mime_type: 'audio/ogg' },
    });
    expect(v.media?.kind).toBe('voice');
    expect(v.media?.mimeType).toBe('audio/ogg');
    const d = msg({
      chat: { id: 1, type: 'private' },
      message_id: 1,
      document: { file_id: 'd1', file_name: 'a.pdf', mime_type: 'application/pdf' },
    });
    expect(d.media).toEqual({
      kind: 'document',
      fileId: 'd1',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
    });
  });
});

describe('normalizeCallback', () => {
  it('maps callback query fields', () => {
    const cb = normalizeCallback({
      id: 'q1',
      data: 'perm_allow_x',
      from: { id: 55 },
      message: { chat: { id: 123, type: 'private' }, message_id: 42 },
      // biome-ignore lint/suspicious/noExplicitAny: partial Bot API payload
    } as any);
    expect(cb).toEqual({
      id: 'q1',
      chatId: 123,
      chatType: 'private',
      messageId: 42,
      data: 'perm_allow_x',
      fromId: 55,
      raw: expect.anything(),
    });
  });
});

function fakeTelegramLike(): TelegramLike & {
  api: Record<string, ReturnType<typeof vi.fn>>;
  handlers: Map<string, (ctx: unknown) => unknown>;
  catchHandler: ((err: unknown, ctx: unknown) => unknown) | null;
} {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  const fake = {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 99 })),
      editMessageText: vi.fn(async () => true),
      setMessageReaction: vi.fn(async () => true),
      answerCallbackQuery: vi.fn(async () => true),
      sendChatAction: vi.fn(async () => true),
      setMyCommands: vi.fn(async () => true),
      getFile: vi.fn(async () => ({ file_path: 'doc/file.pdf' })),
      sendPhoto: vi.fn(async () => ({ message_id: 5 })),
      sendDocument: vi.fn(async () => ({ message_id: 6 })),
    },
    handlers,
    catchHandler: null as ((err: unknown, ctx: unknown) => unknown) | null,
    on(kind: string, handler: (ctx: unknown) => unknown) {
      handlers.set(kind, handler);
    },
    catch(handler: (err: unknown, ctx: unknown) => unknown) {
      fake.catchHandler = handler;
    },
    startPolling: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  return fake as unknown as ReturnType<typeof fakeTelegramLike>;
}

describe('TelegramTransport', () => {
  it('routes inbound messages through normalize + handler', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    const received: unknown[] = [];
    await t.start({ onMessage: async (m) => void received.push(m) });
    await tg.handlers.get('message')?.({
      message: { chat: { id: 5, type: 'private' }, message_id: 1, text: 'hi' },
    });
    expect(received[0]).toMatchObject({ chatId: 5, text: 'hi' });
  });

  it('routes callback queries through the callback handler', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    const received: unknown[] = [];
    await t.start({
      onMessage: async () => {},
      onCallback: async (c) => void received.push(c),
    });
    await tg.handlers.get('callback_query')?.({
      callbackQuery: {
        id: 'q1',
        data: 'x',
        from: { id: 1 },
        message: { chat: { id: 5, type: 'private' }, message_id: 2 },
      },
    });
    expect(received[0]).toMatchObject({ id: 'q1', chatId: 5, data: 'x' });
  });

  it('registers a catch boundary for handler errors', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    await t.start({ onMessage: async () => {} });
    expect(tg.catchHandler).not.toBeNull();
    // Feeding an error through the boundary must not throw and must
    // degrade health.
    tg.catchHandler?.(new Error('fetch failed'), {});
    expect(t.health().ok).toBe(false);
    expect(t.health().lastError?.kind).toBe('network');
  });

  it('send maps to api.sendMessage with snake_case params', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    const [e, r] = await t.send(123, 'hi', {
      parseMode: 'Markdown',
      replyToId: 7,
      keyboard: [[{ text: 'OK', callback_data: 'ok', style: 'success' }]],
    });
    expect(e).toBeNull();
    expect(r.messageId).toBe(99);
    expect(tg.api.sendMessage).toHaveBeenCalledWith({
      chat_id: 123,
      text: 'hi',
      parse_mode: 'Markdown',
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] },
    });
  });

  it('returns api errors as Results without retrying', async () => {
    const tg = fakeTelegramLike();
    tg.api.sendMessage.mockRejectedValueOnce(new Error('bad request'));
    const t = new TelegramTransport(tg, 'tok');
    const [e] = await t.send(1, 'x');
    expect(e?.kind).toBe('api');
    expect(tg.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(t.health().ok).toBe(false);
  });

  it('fileUrl builds the download URL from file_path', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    const [e, url] = await t.fileUrl('fid');
    expect(e).toBeNull();
    expect(url).toBe('https://api.telegram.org/file/bottok/doc/file.pdf');
  });

  it('health recovers to ok after the error ages out', async () => {
    const tg = fakeTelegramLike();
    const t = new TelegramTransport(tg, 'tok');
    tg.api.sendMessage.mockRejectedValue(new Error('fetch failed'));
    await t.send(1, 'x');
    expect(t.health().ok).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: mutate private clock for the test
    (t as any).lastError.at = Date.now() - 120_000;
    expect(t.health().ok).toBe(true);
    expect(t.health().lastError?.kind).toBe('network');
  });
});

describe('mapDiscordError', () => {
  it('maps network-shaped errors to network', () => {
    expect(mapDiscordError(new Error('read ECONNRESET')).kind).toBe('network');
    expect(mapDiscordError(new Error('fetch failed')).kind).toBe('network');
  });

  it('maps unknown errors to api', () => {
    expect(mapDiscordError(new Error('random')).kind).toBe('api');
  });
});

describe('TransportError contract', () => {
  it('Result tuples are disjoint', () => {
    const ok: Result<number> = [null, 1];
    const bad: Result<number> = [apiErr('x')[0] as TransportError, null];
    expect(ok[0]).toBeNull();
    expect(bad[1]).toBeNull();
  });
});
