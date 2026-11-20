import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type Message,
} from 'discord.js';
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
 * Minimal structural view of the discord.js Client — the transport only
 * needs this subset, so tests inject a fake.
 */
export interface DiscordLike {
  login(token: string): Promise<unknown>;
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  channels: { cache: { get(id: string): unknown } };
  user?: { id?: string } | null;
}

interface DiscordMessage {
  id: string;
  edit(text: string): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
  reactions: {
    cache: { get(emoji: string): { users: { remove(id?: string): Promise<unknown> } } | undefined };
  };
}

interface DiscordChannel {
  id: string;
  name?: string;
  type?: number;
  send(payload: unknown): Promise<{ id: string }>;
  sendTyping(): Promise<unknown>;
  messages: { fetch(id: string): Promise<DiscordMessage> };
}

const STYLE: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** discord.js error taxonomy → TransportError. */
export function mapDiscordError(e: unknown): TransportError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof DiscordAPIError) {
    const status = e.status;
    if (status === 429) {
      const retry = (e.rawError as { retry_after?: number } | undefined)?.retry_after;
      return {
        kind: 'rate_limited',
        message: msg,
        retryAfterMs: retry ? retry * 1000 : undefined,
        code: status,
      };
    }
    if (status >= 500) return { kind: 'network', message: msg, code: status };
    if (status === 401) return { kind: 'fatal', message: `unauthorized: ${msg}`, code: status };
    // 403 = missing permissions / blocked, other 4xx = bad request — permanent per call.
    return { kind: 'api', message: msg, code: status };
  }
  if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|socket/i.test(msg)) {
    return { kind: 'network', message: msg };
  }
  return { kind: 'api', message: msg };
}

/** Normalize a discord.js Message → InboundMessage. */
export function normalizeDiscordMessage(msg: Message): InboundMessage {
  const isDm = msg.channel.type === ChannelType.DM || msg.channel.type === ChannelType.GroupDM;
  const base: InboundMessage = {
    chatId: msg.channel.id,
    chatType: isDm ? 'private' : String(msg.channel.type),
    chatTitle:
      'name' in msg.channel && typeof msg.channel.name === 'string' ? msg.channel.name : undefined,
    messageId: msg.id,
    text: msg.content || '',
    caption: msg.content,
    raw: msg,
  };
  const name = msg.author?.displayName || msg.author?.username;
  if (name) {
    base.sender = { id: msg.author.id, name, username: msg.author.username };
  }
  const first = msg.attachments?.first?.();
  if (first) {
    const mime = first.contentType || 'application/octet-stream';
    base.media = {
      kind: first.contentType?.startsWith('audio/') ? 'audio' : 'document',
      fileId: first.id,
      fileName: first.name ?? undefined,
      mimeType: mime,
      url: first.url,
    };
  }
  return base;
}

export function normalizeDiscordInteraction(interaction: {
  id: string;
  customId?: string;
  channel?: { id?: string; type?: number } | null;
  message?: { id?: string } | null;
  user?: { id?: string };
}): InboundCallback {
  const type = interaction.channel?.type;
  return {
    id: interaction.id,
    chatId: interaction.channel?.id,
    chatType:
      type === ChannelType.DM || type === ChannelType.GroupDM ? 'private' : String(type ?? ''),
    messageId: interaction.message?.id,
    data: interaction.customId || '',
    fromId: interaction.user?.id,
    raw: interaction,
  };
}

/**
 * Thin adapter over discord.js: the library already handles gateway
 * reconnection and REST rate-limit queues internally — the transport adds
 * error classification, bounded retry for send-path transients, and health.
 */
export class DiscordTransport implements PlatformTransport {
  readonly platform = 'discord';
  private lastError: TransportHealth['lastError'];
  private started = false;

  constructor(
    private client: DiscordLike,
    private token: string
  ) {}

  async start(handlers: TransportEventHandlers): Promise<void> {
    if (this.started) return;
    this.started = true;
    // discord.js ignores listener return values — capture every handler
    // outcome so a rejection can never float into unhandledRejection.
    this.client.on(Events.MessageCreate, (msg) => {
      const m = msg as Message;
      if (m.author?.bot) return;
      return Promise.resolve(handlers.onMessage(normalizeDiscordMessage(m))).catch((err) =>
        this._track(mapDiscordError(err))
      );
    });
    if (handlers.onCallback) {
      const cb = handlers.onCallback;
      this.client.on(Events.InteractionCreate, (interaction) =>
        Promise.resolve(
          cb(
            normalizeDiscordInteraction(
              interaction as Parameters<typeof normalizeDiscordInteraction>[0]
            )
          )
        ).catch((err) => this._track(mapDiscordError(err)))
      );
    }
    this.client.on(Events.Error, (err) => {
      this._track(mapDiscordError(err));
    });
    await this.client.login(this.token);
  }

  stop(): void {
    this.client.destroy();
  }

  private _track(e: TransportError): void {
    this.lastError = { kind: e.kind, message: e.message, at: Date.now() };
    log.warn(`discord ${e.kind}: ${e.message}`);
  }

  health(): TransportHealth {
    return {
      ok: this.lastError === undefined || Date.now() - this.lastError.at > 60_000,
      lastError: this.lastError,
    };
  }

  private _channel(chatId: ChatId): DiscordChannel | null {
    return (this.client.channels.cache.get(String(chatId)) as DiscordChannel | undefined) ?? null;
  }

  private _components(opts?: SendOpts): Record<string, unknown> {
    if (!opts?.keyboard) return {};
    const rows = opts.keyboard.map((row) => {
      const r = new ActionRowBuilder<ButtonBuilder>();
      for (const b of row) {
        r.addComponents(
          new ButtonBuilder()
            .setCustomId(b.callback_data)
            .setLabel(b.text)
            .setStyle(STYLE[b.style ?? 'primary'] ?? ButtonStyle.Primary)
        );
      }
      return r;
    });
    return { components: rows };
  }

  private _reply(opts?: SendOpts): Record<string, unknown> {
    return opts?.replyToId !== undefined
      ? {
          reply: { messageReference: String(opts.replyToId), failIfNotExists: false },
          allowedMentions: { repliedUser: false },
        }
      : {};
  }

  async send(chatId: ChatId, text: string, opts?: SendOpts): Promise<Result<SendResult>> {
    const channel = this._channel(chatId);
    if (!channel) return [{ kind: 'api', message: `Channel ${chatId} not found` }, null];
    const [e, msg] = await withRetry(() =>
      tryC(
        () => channel.send({ content: text, ...this._components(opts), ...this._reply(opts) }),
        mapDiscordError
      )
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, { messageId: msg.id }];
  }

  async edit(chatId: ChatId, messageId: ChatId, text: string): Promise<Result<void>> {
    const channel = this._channel(chatId);
    if (!channel) return [{ kind: 'api', message: `Channel ${chatId} not found` }, null];
    const [e] = await withRetry(() =>
      tryC(async () => {
        const msg = await channel.messages.fetch(String(messageId));
        await msg.edit(text);
      }, mapDiscordError)
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
    const channel = this._channel(chatId);
    if (!channel) return [{ kind: 'api', message: `Channel ${chatId} not found` }, null];
    const userId = this.client.user?.id;
    const [e] = await withRetry(() =>
      tryC(async () => {
        const msg = await channel.messages.fetch(String(messageId));
        if (remove) {
          await msg.reactions.cache.get(emoji)?.users.remove(userId);
        } else {
          await msg.react(emoji);
        }
      }, mapDiscordError)
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async typing(chatId: ChatId): Promise<Result<void>> {
    const channel = this._channel(chatId);
    if (!channel) return [{ kind: 'api', message: `Channel ${chatId} not found` }, null];
    const [e] = await tryC(() => channel.sendTyping(), mapDiscordError);
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }

  async sendFile(
    chatId: ChatId,
    filePath: string,
    opts?: { caption?: string; isImage?: boolean }
  ): Promise<Result<void>> {
    const channel = this._channel(chatId);
    if (!channel) return [{ kind: 'api', message: `Channel ${chatId} not found` }, null];
    const [e] = await withRetry(() =>
      tryC(() => channel.send({ files: [filePath], content: opts?.caption }), mapDiscordError)
    );
    if (e) {
      this._track(e);
      return [e, null];
    }
    return [null, undefined];
  }
}

/** Production constructor: builds the discord.js Client. */
export function createDiscordTransport(token: string): DiscordTransport {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  return new DiscordTransport(client as unknown as DiscordLike, token);
}
