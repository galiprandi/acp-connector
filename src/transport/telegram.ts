import {
  Bot,
  type CallbackQuery,
  type Context,
  type Message,
  NetworkError,
  TelegramApiError,
  TimeoutError,
} from 'node-telegram-bot-api';
import { fromPath } from 'node-telegram-bot-api/node';
import { log } from '../logger.js';
import { tryC, withRetry } from './retry.js';
import type {
  ChatId,
  InboundCallback,
  InboundMessage,
  PlatformTransport,
  Result,
  SendOpts,
  SendResult,
  TransportError,
  TransportEventHandlers,
  TransportHealth,
} from './types.js';

/**
 * Minimal structural view of the v2 `Bot` — the transport only needs this
 * subset, so tests inject a fake instead of the real client.
 */
export interface TelegramLike {
  api: {
    sendMessage(p: Record<string, unknown>): Promise<Message>;
    editMessageText(p: Record<string, unknown>): Promise<unknown>;
    setMessageReaction(p: Record<string, unknown>): Promise<unknown>;
    answerCallbackQuery(p: Record<string, unknown>): Promise<unknown>;
    sendChatAction(p: Record<string, unknown>): Promise<unknown>;
    setMyCommands(p: Record<string, unknown>): Promise<unknown>;
    getFile(p: { file_id: string }): Promise<{ file_path?: string }>;
    sendPhoto(p: Record<string, unknown>): Promise<Message>;
    sendDocument(p: Record<string, unknown>): Promise<Message>;
  };
  on(kind: string | string[], handler: (ctx: Context) => unknown): unknown;
  catch(handler: (err: unknown, ctx: Context) => unknown): unknown;
  startPolling(): Promise<void>;
  stop(): void;
}

const API_BASE = 'https://api.telegram.org';

/** v2 error taxonomy → TransportError. */
export function mapTelegramError(e: unknown): TransportError {
  if (e instanceof TimeoutError || e instanceof NetworkError) {
    return { kind: 'network', message: e.message };
  }
  if (e instanceof TelegramApiError) {
    if (e.errorCode === 429) {
      return {
        kind: 'rate_limited',
        message: e.message,
        retryAfterMs: (e.retryAfter ?? 1) * 1000,
        code: 429,
      };
    }
    if (e.errorCode >= 500) {
      return { kind: 'network', message: e.message, code: e.errorCode };
    }
    if (e.errorCode === 401) {
      return { kind: 'fatal', message: `unauthorized: ${e.message}`, code: e.errorCode };
    }
    return { kind: 'api', message: e.message, code: e.errorCode };
  }
  // fetch/undici AggregateError and friends — treat as transient.
  const msg = e instanceof Error ? e.message : String(e);
  if (/AggregateError|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(msg)) {
    return { kind: 'network', message: msg };
  }
  return { kind: 'api', message: msg };
}

/** Normalize a Bot API Message → InboundMessage. */
export function normalizeMessage(msg: Message): InboundMessage {
  const base: InboundMessage = {
    chatId: msg.chat.id,
    chatType: msg.chat.type,
    chatTitle: (msg.chat as { title?: string }).title,
    messageId: msg.message_id,
    text: msg.text || '',
    caption: msg.caption,
    raw: msg,
  };
  const from = msg.from;
  if (from) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
    base.sender = { id: from.id, name: name || undefined, username: from.username };
  }
  const reply = msg.reply_to_message;
  if (reply) {
    const quote = (reply.text || reply.caption || '').trim();
    if (quote) {
      base.replyTo = {
        author: reply.from?.username ? `@${reply.from.username}` : undefined,
        text: quote,
      };
    }
  }
  const media = msg.photo?.length
    ? { kind: 'photo' as const, file: msg.photo[msg.photo.length - 1], mime: 'image/jpeg' }
    : msg.document
      ? { kind: 'document' as const, file: msg.document, mime: msg.document.mime_type }
      : msg.sticker
        ? { kind: 'sticker' as const, file: msg.sticker, mime: 'image/webp' }
        : msg.voice
          ? { kind: 'voice' as const, file: msg.voice, mime: msg.voice.mime_type }
          : msg.audio
            ? { kind: 'audio' as const, file: msg.audio, mime: msg.audio.mime_type }
            : msg.video
              ? { kind: 'video' as const, file: msg.video, mime: msg.video.mime_type }
              : null;
  if (media) {
    base.media = {
      kind: media.kind,
      fileId: media.file.file_id,
      fileName: (media.file as { file_name?: string }).file_name,
      mimeType: media.mime || 'application/octet-stream',
    };
  }
  return base;
}

export function normalizeCallback(q: CallbackQuery): InboundCallback {
  return {
    id: q.id,
    chatId: q.message?.chat?.id,
    chatType: q.message?.chat?.type,
    messageId: q.message?.message_id,
    data: q.data || '',
    fromId: q.from?.id,
    raw: q,
  };
}

export class TelegramTransport implements PlatformTransport {
  readonly platform = 'telegram';
  private lastError: TransportHealth['lastError'];
  private started = false;

  constructor(
    private bot: TelegramLike,
    private token: string
  ) {}

  async start(handlers: TransportEventHandlers): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bot.on('message', async (ctx) => {
      if (ctx.message) await handlers.onMessage(normalizeMessage(ctx.message));
    });
    if (handlers.onCallback) {
      const cb = handlers.onCallback;
      this.bot.on('callback_query', async (ctx) => {
        if (ctx.callbackQuery) await cb(normalizeCallback(ctx.callbackQuery));
      });
    }
    // Error boundary: handler rejections land here instead of crashing;
    // never rethrow (that would stop the pump).
    this.bot.catch((err) => {
      this._track(mapTelegramError(err));
    });
    void this.bot.startPolling().catch((err) => {
      this._track(mapTelegramError(err));
      log.error('Telegram polling stopped:', (err as Error).message);
    });
  }

  stop(): void {
    this.bot.stop();
  }

  private _track(e: TransportError): void {
    this.lastError = { kind: e.kind, message: e.message, at: Date.now() };
    log.warn(`telegram ${e.kind}: ${e.message}`);
  }

  health(): TransportHealth {
    return {
      ok: this.lastError === undefined || Date.now() - this.lastError.at > 60_000,
      lastError: this.lastError,
    };
  }

  private _reply(opts?: SendOpts): Record<string, unknown> {
    return opts?.replyToId !== undefined
      ? {
          reply_parameters: {
            message_id: Number(opts.replyToId),
            allow_sending_without_reply: true,
          },
        }
      : {};
  }

  private _markup(opts?: SendOpts): Record<string, unknown> {
    // Strip `style` — Discord-only hint the Bot API doesn't know.
    return opts?.keyboard
      ? {
          reply_markup: {
            inline_keyboard: opts.keyboard.map((row) =>
              row.map(({ text, callback_data }) => ({ text, callback_data }))
            ),
          },
        }
      : {};
  }

  private _parse(opts?: SendOpts): Record<string, unknown> {
    return opts?.parseMode ? { parse_mode: opts.parseMode } : {};
  }

  async send(chatId: ChatId, text: string, opts?: SendOpts): Promise<Result<SendResult>> {
    const r = await withRetry(() =>
      tryC(
        () =>
          this.bot.api.sendMessage({
            chat_id: chatId,
            text,
            ...this._parse(opts),
            ...this._reply(opts),
            ...this._markup(opts),
          }),
        mapTelegramError
      )
    );
    const [e, msg] = r;
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, { messageId: msg.message_id }];
  }

  async edit(
    chatId: ChatId,
    messageId: ChatId,
    text: string,
    opts?: SendOpts
  ): Promise<Result<void>> {
    const [e] = await withRetry(() =>
      tryC(
        () =>
          this.bot.api.editMessageText({
            chat_id: chatId,
            message_id: Number(messageId),
            text,
            ...this._parse(opts),
            ...this._markup(opts),
          }),
        mapTelegramError
      )
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async react(
    chatId: ChatId,
    messageId: ChatId,
    emoji: string,
    remove?: boolean
  ): Promise<Result<void>> {
    const [e] = await withRetry(() =>
      tryC(
        () =>
          this.bot.api.setMessageReaction({
            chat_id: chatId,
            message_id: Number(messageId),
            reaction: remove ? [] : [{ type: 'emoji', emoji }],
          }),
        mapTelegramError
      )
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async answerCallback(callbackId: string, text?: string, alert?: boolean): Promise<Result<void>> {
    const [e] = await tryC(
      () =>
        this.bot.api.answerCallbackQuery({
          callback_query_id: callbackId,
          text,
          show_alert: alert,
        }),
      mapTelegramError
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async typing(chatId: ChatId): Promise<Result<void>> {
    const [e] = await tryC(
      () => this.bot.api.sendChatAction({ chat_id: chatId, action: 'typing' }),
      mapTelegramError
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async fileUrl(fileId: string): Promise<Result<string>> {
    const [e, file] = await withRetry(() =>
      tryC(() => this.bot.api.getFile({ file_id: fileId }), mapTelegramError)
    );
    if (e || !file?.file_path) {
      const te = e ?? { kind: 'api' as const, message: 'getFile returned no file_path' };
      this._track(te);
      return [te, null];
    }
    return [null, `${API_BASE}/file/bot${this.token}/${file.file_path}`];
  }

  async sendFile(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string; isImage?: boolean }
  ): Promise<Result<void>> {
    const [e] = await withRetry(() =>
      tryC(async () => {
        const file = await fromPath(filePath);
        const params = {
          chat_id: chatId,
          ...(opts?.caption ? { caption: opts.caption } : {}),
        };
        if (opts?.isImage) {
          await this.bot.api.sendPhoto({ ...params, photo: file });
        } else {
          await this.bot.api.sendDocument({ ...params, document: file });
        }
      }, mapTelegramError)
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async registerCommands(
    commands: Array<{ command: string; description: string }>
  ): Promise<Result<void>> {
    const [e] = await tryC(() => this.bot.api.setMyCommands({ commands }), mapTelegramError);
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }
}

/** Production constructor: wraps the real v2 Bot. */
export function createTelegramTransport(token: string): TelegramTransport {
  return new TelegramTransport(new Bot(token) as unknown as TelegramLike, token);
}
