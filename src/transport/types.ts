/**
 * PlatformTransport — the contract every chat connector implements
 * (Telegram, Discord, loopback, and future ones like Slack).
 *
 * Error model: expected failures (network, rate limits, platform rejections)
 * come back as `Result<T>` — the caller decides retry/propagate/drop.
 * Programmer errors (bugs, broken invariants) still throw.
 */

export type TransportErrorKind =
  /** Transient: DNS, connection reset, timeout, 5xx — retryable. */
  | 'network'
  /** Platform rate limit; `retryAfterMs` honored when present. */
  | 'rate_limited'
  /** Platform rejected the request (4xx) — permanent, do not retry. */
  | 'api'
  /** Auth invalid, bot blocked/kicked — do not retry, surface loudly. */
  | 'fatal';

export interface TransportError {
  kind: TransportErrorKind;
  message: string;
  /** Suggested wait before retrying (rate_limited). */
  retryAfterMs?: number;
  /** Platform error code when available (HTTP status / API error code). */
  code?: number;
}

export type Result<T> = [err: TransportError, data: null] | [err: null, data: T];

export const ok = <T>(data: T): Result<T> => [null, data];
export const err = <T>(error: TransportError): Result<T> => [error, null];

export type ChatId = number | string;

export interface SendOpts {
  /** 'Markdown' | 'HTML' | undefined (plain text). */
  parseMode?: string;
  /** Reply-thread this message to an existing one. */
  replyToId?: ChatId;
  /** Inline keyboard rows: [[{text, callback_data}], ...] — `style` is honored only by platforms with button styles (Discord). */
  keyboard?: Array<
    Array<{ text: string; callback_data: string; style?: 'primary' | 'success' | 'danger' }>
  >;
  /** Caption for file sends (platform-capped by the transport). */
  caption?: string;
}

export interface SendResult {
  messageId: ChatId;
}

/**
 * Normalized inbound events. Transports adapt their platform's payload to
 * this shape — BaseBot never touches a platform-native object.
 */
export interface InboundMessage {
  chatId: ChatId;
  /** 'private' | 'group' | 'supergroup' | 'channel' | 'guild-...' */
  chatType: string;
  chatTitle?: string;
  messageId: ChatId;
  text: string;
  caption?: string;
  sender?: { id?: ChatId; name?: string; username?: string };
  replyTo?: { author?: string; text?: string };
  media?: {
    kind: 'photo' | 'document' | 'sticker' | 'voice' | 'audio' | 'video';
    fileId: string;
    fileName?: string;
    mimeType: string;
    /** Direct download URL when the platform exposes one (Discord CDN). */
    url?: string;
  };
  /** Platform-native payload for edge cases the shape doesn't cover. */
  raw?: unknown;
}

export interface InboundCallback {
  id: string;
  chatId?: ChatId;
  chatType?: string;
  messageId?: ChatId;
  data: string;
  fromId?: ChatId;
  raw?: unknown;
}

export interface TransportEventHandlers {
  onMessage(msg: InboundMessage): Promise<void> | void;
  onCallback?(cb: InboundCallback): Promise<void> | void;
}

export interface TransportHealth {
  ok: boolean;
  lastError?: { kind: TransportErrorKind; message: string; at: number };
}

/**
 * The connector contract. Optional methods: a transport implements them
 * only when the platform supports the feature (Discord has no getFile
 * indirection — media arrives with CDN URLs already).
 */
export interface PlatformTransport {
  readonly platform: string;
  start(handlers: TransportEventHandlers): Promise<void>;
  stop(): void;
  send(chatId: ChatId, text: string, opts?: SendOpts): Promise<Result<SendResult>>;
  edit(chatId: ChatId, messageId: ChatId, text: string, opts?: SendOpts): Promise<Result<void>>;
  /** Add a reaction, or remove it with `remove: true` (platforms differ: Telegram clears the bot's reaction set, Discord removes just that emoji). */
  react?(chatId: ChatId, messageId: ChatId, emoji: string, remove?: boolean): Promise<Result<void>>;
  answerCallback?(callbackId: string, text?: string, alert?: boolean): Promise<Result<void>>;
  typing?(chatId: ChatId): Promise<Result<void>>;
  fileUrl?(fileId: string): Promise<Result<string>>;
  sendFile?(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string; isImage?: boolean }
  ): Promise<Result<void>>;
  registerCommands?(
    commands: Array<{ command: string; description: string }>
  ): Promise<Result<void>>;
  health(): TransportHealth;
}
