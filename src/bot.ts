import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client.js';
import type { AliasDirectory } from './aliases.js';
import type { PermissionResponse } from './base-bot.js';
import { BaseBot } from './base-bot.js';
import type { SenderInfo } from './identity.js';
import { errorMessage, log } from './logger.js';
import { fetchBuffer, type MediaHandler } from './media.js';
import type {
  ChatId,
  InboundCallback,
  InboundMessage,
  PlatformTransport,
  Result,
} from './transport/types.js';
import type { WebhookEmitter } from './webhooks.js';

const TG_MAX_LEN = 4096;
const TG_CAPTION_MAX = 1024;
const TG_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/**
 * Prompt provenance. 'job'/'agent-job' come from the unified job
 * scheduler (operator vs agent-managed — agent jobs are remote content);
 * 'http' is POST /prompt; 'a2a' is a remote peer. User messages have no
 * source.
 */
export type PromptSource = 'job' | 'agent-job' | 'http' | 'a2a';

export interface PlatformBot {
  start(): Promise<void>;
  stop(): void;
  enqueuePrompt(
    text: string,
    chatId?: number | string,
    blocks?: ContentBlock[],
    onComplete?: (response: string, error?: string) => void,
    source?: PromptSource
  ): Promise<void>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  /** Send a local file — used by the acp-tools send_file tool. */
  sendFile?(chatId: number | string, filePath: string, caption?: string): Promise<void>;
  /** Chat the agent is currently talking to (busy prompt, else last user chat). */
  defaultChatTarget?(): { platform: string; chatId: string | number } | null;
  /** Platform label ('telegram', 'discord') for alias routing. */
  readonly platform?: string;
  notifyAgentExit(code: number | null): Promise<void>;
  hasActivePrompt(): boolean;
  setMediaHandler(handler: MediaHandler): void;
  setCommandHandler(fn: ((text: string, chatId: number | string) => Promise<boolean>) | null): void;
  /** Outbound event webhooks — optional, no-op when unset. */
  setWebhooks?(emitter: WebhookEmitter | null): void;
  /** Transport health for /status — absent when the bot has no transport. */
  transportHealth?(): { ok: boolean; lastError?: { kind: string; message: string; at: number } };
}

interface BridgeBotOpts {
  acp: AcpClient;
  transport: PlatformTransport;
  allowedChatIds: number[];
  allowedUserIds?: number[];
  agentCmd: string;
  showThoughts?: boolean;
  showTools?: boolean;
  showPlan?: boolean;
  streaming?: boolean;
  echoInjectedPrompts?: boolean;
  logPreviewLength?: number;
  mediaHandler?: MediaHandler | null;
  onCommand?: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt?: ((text: string, chatId: number | string) => void) | null;
  aliases?: AliasDirectory | null;
  timezone?: string;
  jobsSummary?: () => string | null;
  networkSummary?: () => string | null;
}

/** Telegram rate-limit/parse rejections that deserve a plain-text retry. */
const isParseError = (msg: string) => msg.includes('parse') || msg.includes('entity');

export class BridgeBot extends BaseBot {
  private allowedChatIds: Set<number>;
  private allowedUserIds: Set<number>;
  private transport: PlatformTransport;

  protected readonly maxLen = TG_MAX_LEN;

  constructor({
    acp,
    transport,
    allowedChatIds,
    allowedUserIds = [],
    agentCmd,
    showThoughts = false,
    showTools = true,
    showPlan = true,
    streaming = true,
    echoInjectedPrompts = true,
    logPreviewLength,
    mediaHandler = null,
    onCommand = null,
    onPrompt = null,
    aliases = null,
    timezone,
    jobsSummary,
    networkSummary,
  }: BridgeBotOpts) {
    super({
      acp,
      agentCmd,
      showThoughts,
      showTools,
      showPlan,
      streaming,
      echoInjectedPrompts,
      logPreviewLength,
      mediaHandler,
      onCommand,
      onPrompt,
      platformName: 'telegram',
      aliases,
      timezone,
      jobsSummary,
      networkSummary,
    });
    this.allowedChatIds = new Set(allowedChatIds);
    this.allowedUserIds = new Set(allowedUserIds);
    this.transport = transport;
  }

  transportHealth() {
    return this.transport.health();
  }

  /** Throw the transport error — keeps BaseBot's try/catch semantics. */
  private _must<T>(r: Result<T>): T {
    const [e, data] = r;
    if (e) throw new Error(`${e.kind}: ${e.message}`);
    return data;
  }

  async start(): Promise<void> {
    await this.transport.start({
      onMessage: async (msg) => {
        try {
          await this._onMessage(msg);
        } catch (err) {
          log.error('Unhandled message error:', errorMessage(err));
          const [e] = await this.transport.send(msg.chatId, `⚠️ ${errorMessage(err).slice(0, 200)}`);
          if (e) log.error('Error report failed:', e.message);
        }
      },
      onCallback: (cb) => this._onCallback(cb),
    });
    // Register the command menu — typing "/" in Telegram shows these
    // with descriptions instead of making users memorize the grammar.
    const [e] = (await this.transport.registerCommands?.([
      { command: 'stop', description: 'Cancel the current task' },
      { command: 'sessions', description: 'List/switch sessions (new, <n>, rm)' },
      { command: 'config', description: 'Show or set session options' },
      { command: 'queue', description: 'List or clear pending prompts' },
      { command: 'jobs', description: 'Scheduled & manual jobs' },
      { command: 'time', description: 'Host/config/UTC clocks' },
      { command: 'status', description: 'Agent state and uptime' },
      { command: 'help', description: 'Show all commands' },
    ])) ?? [null, undefined];
    if (e) log.warn(`setMyCommands failed: ${e.message}`);
  }

  stop(): void {
    this._stopTypingLoop();
    this.transport.stop();
  }

  private _isAllowed(chatId: ChatId): boolean {
    return this.allowedChatIds.has(Number(chatId));
  }

  protected _currentChannel(): string | number | null {
    return this.currentChannelId;
  }

  protected async _sendNewMessage(text: string): Promise<{ messageId: number | string }> {
    const chatId = this._currentChannel() as number;
    if (!chatId) throw new Error('No active chat');
    const [e, r] = await this.transport.send(chatId, text, { parseMode: 'Markdown' });
    if (!e) return { messageId: r.messageId };
    if (e.kind === 'api' && isParseError(e.message)) {
      const r2 = await this.transport.send(chatId, text);
      return { messageId: this._must(r2).messageId };
    }
    throw new Error(`${e.kind}: ${e.message}`);
  }

  protected async _editMessage(messageId: number | string, text: string): Promise<void> {
    const chatId = this._currentChannel() as number;
    if (!chatId) return;
    const [e] = await this.transport.edit(chatId, messageId, text, { parseMode: 'Markdown' });
    if (!e) return;
    if (e.kind === 'api' && isParseError(e.message)) {
      const [e2] = await this.transport.edit(chatId, messageId, text);
      if (e2) throw new Error(`${e2.kind}: ${e2.message}`);
      return;
    }
    throw new Error(`${e.kind}: ${e.message}`);
  }

  protected async _sendOverflowChunk(chunk: string): Promise<void> {
    const chatId = this._currentChannel() as number;
    if (!chatId) return;
    const [e] = await this.transport.send(chatId, chunk, { parseMode: 'Markdown' });
    if (e && e.kind === 'api' && isParseError(e.message)) {
      await this._sendPlain(chunk).catch(() => {});
    }
  }

  protected async _sendPlain(text: string, chatId?: string | number): Promise<void> {
    const target = (chatId ?? this._currentChannel()) as number;
    if (!target) return;
    this._must(await this.transport.send(target, text));
  }

  protected async _addQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    this._must(await (this.transport.react?.(channelId, messageId, '😴') ?? [null, undefined]));
  }

  protected async _clearQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    this._must(
      await (this.transport.react?.(channelId, messageId, '😴', true) ?? [null, undefined])
    );
  }

  protected async _addTranscribingReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    // Telegram only allows a fixed emoji set for reactions — 🤔 signals
    // "processing" (🎧/🎙/👂 are not in the allowed list).
    this._must(await (this.transport.react?.(channelId, messageId, '🤔') ?? [null, undefined]));
  }

  protected async _clearTranscribingReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    this._must(
      await (this.transport.react?.(channelId, messageId, '🤔', true) ?? [null, undefined])
    );
  }

  private async _onMessage(msg: InboundMessage): Promise<void> {
    const chatId = msg.chatId;
    const text = msg.text || '';

    if (!this._isAllowed(chatId)) {
      log.info(`🚫 [${chatId}] ${this._sanitize(text)}`);
      if (this.allowedChatIds.size === 0) {
        await this.transport.send(
          chatId,
          [
            `Your chat ID is: ${chatId}`,
            '',
            'To allow this chat, add it to acp-connector.jsonc:',
            '',
            `  "allowedChatIds": [${chatId}]`,
            '',
            'Then restart the bridge.',
          ].join('\n')
        );
      }
      return;
    }

    if (!text && msg.media) {
      if (!this.mediaHandler) {
        await this.transport.send(chatId, 'Media no soportado');
        return;
      }
      await this._handleMedia(msg, chatId);
      return;
    }

    if (await this._handleBuiltinCommand(text, chatId)) return;

    if (!text || text.trim() === '') return;

    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }

    const preview = text.slice(0, this.previewLength).replace(/\n/g, ' ');
    log.info(`👤 ${preview}${text.length > this.previewLength ? '…' : ''}`);

    this._enqueueUserMessage(
      chatId,
      msg.messageId,
      `${this._replyContext(msg)}${text}`,
      undefined,
      this._senderInfo(msg)
    );
  }

  /**
   * Sender/chat identity for the prompt prefix and alias directory.
   * DMs: sender name doubles as chat name; groups: chatTitle is the
   * destination, sender is who spoke.
   */
  private _senderInfo(msg: InboundMessage): SenderInfo | undefined {
    const isGroup = msg.chatType !== 'private';
    const name = msg.sender?.name || (msg.sender?.username ? `@${msg.sender.username}` : '');
    // No identifiable sender (e.g. channel posts) → no prefix, no alias.
    if (!name) return undefined;
    return { name, isGroup, chatName: isGroup ? msg.chatTitle : undefined };
  }

  private _replyContext(msg: InboundMessage): string {
    const reply = msg.replyTo;
    if (!reply?.text) return '';
    const author = reply.author ? ` ${reply.author}` : '';
    const snippet = reply.text.slice(0, 300).replace(/\n/g, ' ');
    const suffix = reply.text.length > 300 ? '…' : '';
    return `[in reply to${author}: "${snippet}${suffix}"] `;
  }

  private _mediaExt(kind: string, fileName?: string): { mimeType: string; ext: string } {
    switch (kind) {
      case 'photo':
        return { mimeType: 'image/jpeg', ext: 'jpg' };
      case 'sticker':
        return { mimeType: 'image/webp', ext: 'webp' };
      case 'voice':
        return { mimeType: 'audio/ogg', ext: 'ogg' };
      case 'audio':
        return { mimeType: 'audio/mpeg', ext: 'mp3' };
      case 'video':
        return { mimeType: 'video/mp4', ext: 'mp4' };
      default:
        return {
          mimeType: 'application/octet-stream',
          ext: fileName?.split('.').pop() || 'bin',
        };
    }
  }

  private async _handleMedia(msg: InboundMessage, chatId: ChatId): Promise<void> {
    const media = msg.media;
    const mediaHandler = this.mediaHandler;
    if (!media || !mediaHandler || !this.transport.fileUrl) return;

    const caption = msg.caption || '';
    const { ext } = this._mediaExt(media.kind, media.fileName);

    // Voice notes go through transcription when enabled: the agent receives
    // plain text and the audio file is deleted afterwards.
    if (media.kind === 'voice' && mediaHandler.canTranscribe) {
      await this._handleVoiceNote(msg, chatId, media.fileId, media.mimeType, ext, caption);
      return;
    }

    const stopTyping = this._startTransientTyping(chatId);
    try {
      const [linkErr, link] = await this.transport.fileUrl(media.fileId);
      if (linkErr || !link) {
        log.error('Media file link failed:', linkErr?.message);
        await this.transport.send(chatId, `Error downloading media: ${linkErr?.message}`);
        return;
      }
      const blocks = await mediaHandler.processMedia(
        () => fetchBuffer(link),
        media.mimeType,
        ext,
        caption || undefined
      );
      const preview = caption ? `📷 ${caption.slice(0, 60)}` : `📷 ${media.mimeType}`;
      log.info(`👤 ${preview}`);
      this._enqueueUserMessage(
        chatId,
        msg.messageId,
        `${this._replyContext(msg)}${caption || `[📄 file]`}`,
        blocks,
        this._senderInfo(msg)
      );
    } catch (err) {
      log.error('Media download failed:', errorMessage(err));
      await this.transport.send(chatId, `Error downloading media: ${errorMessage(err)}`);
    } finally {
      stopTyping();
    }
  }

  private async _handleVoiceNote(
    msg: InboundMessage,
    chatId: ChatId,
    fileId: string,
    mimeType: string,
    ext: string,
    caption: string
  ): Promise<void> {
    const messageId = msg.messageId;
    const mediaHandler = this.mediaHandler;
    if (!mediaHandler || !this.transport.fileUrl) return;
    const stopTyping = this._startTransientTyping(chatId);
    await this._addTranscribingReaction(chatId, messageId).catch(() => {});
    try {
      const [linkErr, link] = await this.transport.fileUrl(fileId);
      if (linkErr || !link) throw new Error(linkErr?.message || 'no file link');
      const blocks = await mediaHandler.processVoiceNote(
        () => fetchBuffer(link),
        mimeType,
        ext,
        caption || undefined
      );
      const preview = caption ? `🎙️ ${caption.slice(0, 60)}` : '🎙️ voice note';
      log.info(`👤 ${preview}`);
      this._enqueueUserMessage(
        chatId,
        messageId,
        `${this._replyContext(msg)}${caption || '[voice message]'}`,
        blocks,
        this._senderInfo(msg)
      );
    } catch (err) {
      log.error('Voice transcription failed:', errorMessage(err));
      await this.transport.send(chatId, '🎙️ Transcription failed — please resend the voice note.');
    } finally {
      stopTyping();
      await this._clearTranscribingReaction(chatId, messageId).catch(() => {});
    }
  }

  protected async _handleBuiltinCommand(text: string, chatId: string | number): Promise<boolean> {
    if (await this._handleSessionCommand(text, chatId)) return true;

    const cid = chatId as number;
    if (text === '/stop') {
      if (!this.busy) {
        await this.transport.send(cid, 'Nothing to stop.');
        return true;
      }
      try {
        await this.acp.cancel();
        this.queue = [];
        await this.transport.send(cid, '⏹ Stopped.');
        this._emit('prompt.cancelled', {}, cid);
        log.info('⏹ stop requested');
      } catch (err) {
        await this.transport.send(cid, `Stop failed: ${(err as Error).message}`);
      }
      return true;
    }

    if (text !== '/start' && text !== '/help') return false;
    await this.sendMessage(
      cid,
      [
        '👋 *acp-connector*',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '*Commands:*',
        ...this._bridgeCommandHelpLines(),
        '',
        'Any other text is sent to the agent.',
        '',
        '📖 Docs: https://github.com/galiprandi/acp-connector#readme',
      ].join('\n')
    );
    return true;
  }

  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types are complex
  async _handlePermission(params: any): Promise<any> {
    const allowOpt = params.options?.find(
      // biome-ignore lint/suspicious/noExplicitAny: SDK option type
      (o: any) => o.kind.startsWith('allow')
    );
    const autoAllow = () =>
      allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } };

    const cmd = (this.agentCmd || '').toLowerCase();
    if (cmd.includes('dangerous') || cmd.includes('bypass') || cmd.includes('yolo')) {
      log.info('⚡ auto-approved');
      return autoAllow();
    }

    if (!params.options || params.options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const chatId = this.currentChannelId as number | null;
    if (!chatId) return autoAllow();

    const desc = this._formatPermission(params);
    log.info(`🔐 permiso: ${desc.slice(0, 60)}`);

    const rejectOpt = params.options?.find(
      // biome-ignore lint/suspicious/noExplicitAny: SDK option type
      (o: any) => o.kind.startsWith('reject')
    );
    const buttons: { text: string; callback_data: string }[] = [];
    if (allowOpt) buttons.push({ text: 'Allow', callback_data: `perm_allow_${allowOpt.optionId}` });
    if (rejectOpt) buttons.push({ text: 'Deny', callback_data: `perm_deny_${rejectOpt.optionId}` });

    const text = `Permission required:\n\n${desc}`.slice(0, TG_MAX_LEN);
    const [sendErr, sent] = await this.transport.send(chatId, text, { keyboard: [buttons] });
    if (sendErr || !sent) return autoAllow();

    return new Promise<PermissionResponse>((resolve) => {
      this.permissionPending = { resolve, messageId: Number(sent.messageId) };
    });
  }

  /**
   * Sensitive callbacks (permission decisions, reconnect) require an operator:
   * private chats are always allowed (single human member); group chats require
   * `from.id` in `allowedUserIds`.
   */
  private _isOperatorCallback(cb: InboundCallback): boolean {
    if (cb.chatType === 'private') return true;
    return cb.fromId !== undefined && this.allowedUserIds.has(Number(cb.fromId));
  }

  private _answer(id: string, text?: string, alert?: boolean): void {
    if (!this.transport.answerCallback) return;
    void this.transport.answerCallback(id, text, alert);
  }

  private async _onCallback(cb: InboundCallback): Promise<void> {
    const chatId = cb.chatId;
    if (!chatId || !this._isAllowed(chatId)) return;

    const data = cb.data || '';
    const sensitive = data === 'reconnect' || data.startsWith('perm_');
    if (sensitive && !this._isOperatorCallback(cb)) {
      this._answer(cb.id, '⛔ Not authorized', true);
      log.warn(`Rejected ${data.split('_')[0]} callback from user ${cb.fromId} in chat ${chatId}`);
      return;
    }
    if (data === 'reconnect') {
      this._answer(cb.id);
      await this.transport.edit(chatId, cb.messageId as ChatId, '🔄 Reconnecting agent…');
      try {
        await this.acp.restart();
        const sessionNote = this.acp.sessionId
          ? `session \`${this.acp.sessionId}\``
          : 'new session';
        await this.transport.edit(
          chatId,
          cb.messageId as ChatId,
          `✅ Agent reconnected — ${sessionNote}`,
          {
            parseMode: 'Markdown',
          }
        );
        log.info(`🔄 agent restarted, session: ${this.acp.sessionId}`);
      } catch (err) {
        await this.transport.edit(
          chatId,
          cb.messageId as ChatId,
          `❌ Reconnect failed: ${(err as Error).message}`
        );
      }
      return;
    }
    if (data.startsWith('perm_') && this.permissionPending) {
      if (Number(cb.messageId) !== this.permissionPending.messageId) {
        this._answer(cb.id, '⌛ Permission request expired');
        return;
      }
      const [, outcome, ...rest] = data.split('_');
      const optionId = rest.join('_');
      const response: PermissionResponse = { outcome: { outcome: 'selected', optionId } };

      this.permissionPending.resolve(response);
      this.permissionPending = null;

      await this.transport.edit(
        chatId,
        cb.messageId as ChatId,
        `Permission: ${outcome === 'allow' ? 'Allowed' : 'Denied'}`
      );
      this._answer(cb.id);
    }
  }

  protected _sendTypingTo(chatId: string | number): void {
    if (!this.transport.typing) return;
    void this.transport.typing(chatId).then(([e]) => {
      if (e) log.debug(`typing indicator failed (${e.kind}): ${e.message}`);
    });
  }

  async notifyAgentExit(code: number | null): Promise<void> {
    const detail = code !== null ? ` (exit code ${code})` : '';
    for (const chatId of this.allowedChatIds) {
      const [e] = await this.transport.send(
        chatId,
        `⚠️ Agent process exited${detail} — connection lost.`,
        { keyboard: [[{ text: '🔄 Reconnect', callback_data: 'reconnect' }]] }
      );
      if (e) log.error(`Failed to notify chat ${chatId}:`, e.message);
    }
  }

  protected async _sendPlatformFile(
    chatId: string | number,
    filePath: string,
    caption?: string
  ): Promise<void> {
    if (!this.transport.sendFile) throw new Error('sendFile not supported by transport');
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    this._must(
      await this.transport.sendFile(chatId, filePath, {
        caption: caption ? caption.slice(0, TG_CAPTION_MAX) : undefined,
        isImage: TG_IMAGE_EXTS.has(ext),
      })
    );
  }

  protected async _sendPlatformMessage(
    chatId: number | string,
    text: string,
    replyToId?: number | string
  ): Promise<{ messageId?: number | string }> {
    const opts = replyToId !== undefined ? { replyToId } : {};
    const [e, r] = await this.transport.send(chatId, text, {
      parseMode: 'Markdown',
      ...opts,
    });
    if (!e) return { messageId: r.messageId };
    if (e.kind === 'api' && isParseError(e.message)) {
      const r2 = await this.transport.send(chatId, text, opts);
      return { messageId: this._must(r2).messageId };
    }
    throw new Error(`${e.kind}: ${e.message}`);
  }
}
