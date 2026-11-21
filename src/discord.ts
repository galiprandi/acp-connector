import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ButtonInteraction, Message } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { AcpClient } from './acp-client.js';
import type { AliasDirectory } from './aliases.js';
import type { PermissionResponse } from './base-bot.js';
import { BaseBot } from './base-bot.js';
import type { SenderInfo } from './identity.js';
import { errorMessage, log } from './logger.js';
import { fetchBuffer, type MediaHandler } from './media.js';
import type {
  InboundCallback,
  InboundMessage,
  PlatformTransport,
  Result,
} from './transport/types.js';

const DISCORD_MAX_LEN = 2000;

interface DiscordBotOpts {
  acp: AcpClient;
  transport: PlatformTransport;
  allowedChannelIds: string[];
  allowedUserIds?: string[];
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

export class DiscordBot extends BaseBot {
  private allowedChannelIds: Set<string>;
  private allowedUserIds: Set<string>;
  private transport: PlatformTransport;
  private currentMessage: { id: string } | null;

  protected readonly maxLen = DISCORD_MAX_LEN;

  constructor({
    acp,
    transport,
    allowedChannelIds,
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
  }: DiscordBotOpts) {
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
      platformName: 'discord',
      aliases,
      timezone,
      jobsSummary,
      networkSummary,
    });
    this.allowedChannelIds = new Set(allowedChannelIds);
    this.allowedUserIds = new Set(allowedUserIds);
    this.transport = transport;
    this.currentMessage = null;
  }

  transportHealth() {
    return this.transport.health();
  }

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
      onCallback: (cb) => this._onInteraction(cb),
    });
  }

  stop(): void {
    this._stopTypingLoop();
    this.transport.stop();
  }

  private _isAllowed(channelId: string): boolean {
    return this.allowedChannelIds.has(channelId);
  }

  protected _currentChannel(): string | number | null {
    return this.currentChannelId;
  }

  protected async _sendNewMessage(text: string): Promise<{ messageId: number | string }> {
    const channelId = this._currentChannel() as string;
    if (!channelId) throw new Error('No active channel');
    const r = this._must(await this.transport.send(channelId, text));
    this.currentMessage = { id: String(r.messageId) };
    return { messageId: r.messageId };
  }

  protected async _editMessage(_messageId: number | string, text: string): Promise<void> {
    const channelId = this._currentChannel() as string;
    if (!channelId || !this.currentMessage) return;
    this._must(await this.transport.edit(channelId, this.currentMessage.id, text));
  }

  protected async _sendOverflowChunk(chunk: string): Promise<void> {
    const channelId = this._currentChannel() as string;
    if (!channelId) return;
    await this.transport.send(channelId, chunk);
  }

  protected async _sendPlain(text: string, chatId?: string | number): Promise<void> {
    const target = (chatId ?? this._currentChannel()) as string;
    if (!target) return;
    this._must(await this.transport.send(target, text));
  }

  protected async _addQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    this._must(await (this.transport.react?.(channelId, messageId, '⏳') ?? [null, undefined]));
  }

  protected async _clearQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    this._must(
      await (this.transport.react?.(channelId, messageId, '⏳', true) ?? [null, undefined])
    );
  }

  protected async _addTranscribingReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    try {
      await this.transport.react?.(channelId, messageId, '🎧');
    } catch {
      /* best-effort UX hint */
    }
  }

  protected async _clearTranscribingReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    try {
      await this.transport.react?.(channelId, messageId, '🎧', true);
    } catch {
      /* best-effort UX hint */
    }
  }

  private async _onMessage(msg: InboundMessage): Promise<void> {
    const channelId = String(msg.chatId);
    const text = msg.text || '';

    if (!this._isAllowed(channelId)) {
      log.info(`🚫 [${channelId}] ${this._sanitize(text)}`);
      if (this.allowedChannelIds.size === 0) {
        await this.transport.send(
          channelId,
          [
            `Your channel ID is: ${channelId}`,
            '',
            'To allow this channel, add it to acp-connector.jsonc:',
            '',
            `  "discord": { "allowedChannelIds": ["${channelId}"] }`,
            '',
            'Then restart the bridge.',
          ].join('\n')
        );
      }
      return;
    }

    if (await this._handleBuiltinCommand(text, channelId)) return;

    // Handle attachments (images, files)
    const raw = msg.raw as Message | undefined;
    if (raw?.attachments && raw.attachments.size > 0 && this.mediaHandler) {
      await this._handleDiscordMedia(msg, raw, channelId);
      return;
    }

    if (!text || text.trim() === '') return;

    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, channelId);
      if (handled) return;
    }

    const preview = text.slice(0, this.previewLength).replace(/\n/g, ' ');
    log.info(`👤 ${preview}${text.length > this.previewLength ? '…' : ''}`);

    const context = await this._replyContext(raw);
    this._enqueueUserMessage(
      channelId,
      msg.messageId,
      `${context}${text}`,
      undefined,
      this._senderInfo(msg)
    );
  }

  /**
   * Sender/chat identity for the prompt prefix and alias directory.
   * DMs: author display name doubles as chat name; guild channels: the
   * channel name is the destination, sender is who spoke.
   */
  private _senderInfo(msg: InboundMessage): SenderInfo | undefined {
    const name = msg.sender?.name || '';
    // No identifiable sender → no prefix, no alias.
    if (!name) return undefined;
    const isGroup = msg.chatType !== 'private';
    return { name, isGroup, chatName: isGroup ? msg.chatTitle : undefined };
  }

  private async _replyContext(msg?: Message): Promise<string> {
    if (!msg?.reference?.messageId) return '';
    const ref = await msg.fetchReference().catch(() => null);
    const quote = (ref?.content || '').trim();
    if (!ref || !quote) return '';
    const author = ref.author?.username ? ` @${ref.author.username}` : '';
    const snippet = quote.slice(0, 300).replace(/\n/g, ' ');
    const suffix = quote.length > 300 ? '…' : '';
    return `[in reply to${author}: "${snippet}${suffix}"] `;
  }

  private async _handleDiscordMedia(
    msg: InboundMessage,
    raw: Message,
    channelId: string
  ): Promise<void> {
    if (!this.mediaHandler) return;
    const caption = msg.caption || '';

    // Discord voice messages (IsVoiceMessage flag) arrive as a single
    // audio/ogg attachment — transcribe them into plain text when enabled.
    const isVoiceMessage = raw.flags.has(MessageFlags.IsVoiceMessage);
    if (isVoiceMessage && this.mediaHandler.canTranscribe) {
      await this._handleDiscordVoiceNote(msg, raw, channelId, caption);
      return;
    }

    const stopTyping = this._startTransientTyping(channelId);
    try {
      const allBlocks: ContentBlock[] = [];
      for (const [, attachment] of raw.attachments) {
        const mimeType = attachment.contentType || 'application/octet-stream';
        const ext = attachment.name?.split('.').pop() || 'bin';
        const downloadFn = () => fetchBuffer(attachment.url);
        const blocks = await this.mediaHandler.processMedia(downloadFn, mimeType, ext);
        allBlocks.push(...blocks);
      }
      if (caption) {
        allBlocks.push({ type: 'text', text: caption } as ContentBlock);
      }
      const preview = caption ? `📷 ${caption.slice(0, 60)}` : `📷 ${raw.attachments.size} file(s)`;
      log.info(`👤 ${preview}`);
      const context = await this._replyContext(raw);
      this._enqueueUserMessage(
        channelId,
        msg.messageId,
        `${context}${caption || '[📄 file]'}`,
        allBlocks,
        this._senderInfo(msg)
      );
    } catch (err) {
      log.error('Discord media download failed:', errorMessage(err));
      await this.transport.send(channelId, `Error downloading media: ${errorMessage(err)}`);
    } finally {
      stopTyping();
    }
  }

  private async _handleDiscordVoiceNote(
    msg: InboundMessage,
    raw: Message,
    channelId: string,
    caption: string
  ): Promise<void> {
    const mediaHandler = this.mediaHandler;
    if (!mediaHandler) return;
    const messageId = msg.messageId;
    const stopTyping = this._startTransientTyping(channelId);
    await this._addTranscribingReaction(channelId, messageId);
    try {
      const allBlocks: ContentBlock[] = [];
      for (const [, attachment] of raw.attachments) {
        const mimeType = attachment.contentType || 'audio/ogg';
        const ext = attachment.name?.split('.').pop() || 'ogg';
        const downloadFn = () => fetchBuffer(attachment.url);
        const blocks = await mediaHandler.processVoiceNote(downloadFn, mimeType, ext);
        allBlocks.push(...blocks);
      }
      if (caption) {
        allBlocks.push({ type: 'text', text: caption } as ContentBlock);
      }
      log.info('👤 🎙️ voice message');
      const context = await this._replyContext(raw);
      this._enqueueUserMessage(
        channelId,
        messageId,
        `${context}${caption || '[voice message]'}`,
        allBlocks,
        this._senderInfo(msg)
      );
    } catch (err) {
      log.error('Discord voice transcription failed:', errorMessage(err));
      await this.transport.send(
        channelId,
        '🎙️ Transcription failed — please resend the voice message.'
      );
    } finally {
      stopTyping();
      await this._clearTranscribingReaction(channelId, messageId);
    }
  }

  protected async _handleBuiltinCommand(
    text: string,
    channelId: string | number
  ): Promise<boolean> {
    if (await this._handleSessionCommand(text, channelId)) return true;

    const cid = String(channelId);
    if (text === '/stop') {
      if (!this.busy) {
        await this.transport.send(cid, 'Nothing to stop.');
        return true;
      }
      try {
        await this.acp.cancel();
        this.queue = [];
        await this.transport.send(cid, '⏹ Stopped.');
        this._emit('prompt.cancelled', {}, channelId);
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
        '👋 **acp-connector**',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '**Commands:**',
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

    const channelId = this.currentChannelId as string | null;
    if (!channelId) return autoAllow();

    const desc = this._formatPermission(params);
    log.info(`🔐 permiso: ${desc.slice(0, 60)}`);

    const rejectOpt = params.options?.find(
      // biome-ignore lint/suspicious/noExplicitAny: SDK option type
      (o: any) => o.kind.startsWith('reject')
    );
    const buttons: { text: string; callback_data: string; style: 'success' | 'danger' }[] = [];
    if (allowOpt)
      buttons.push({
        text: 'Allow',
        callback_data: `perm_allow_${allowOpt.optionId}`,
        style: 'success',
      });
    if (rejectOpt)
      buttons.push({
        text: 'Deny',
        callback_data: `perm_deny_${rejectOpt.optionId}`,
        style: 'danger',
      });

    const content = `Permission required:\n\n${desc}`.slice(0, DISCORD_MAX_LEN);
    const [sendErr, sent] = await this.transport.send(channelId, content, { keyboard: [buttons] });
    if (sendErr || !sent) {
      log.error('Discord permission send failed:', sendErr?.message);
      return autoAllow();
    }

    return new Promise<PermissionResponse>((resolve) => {
      this.permissionPending = { resolve, messageId: String(sent.messageId) };
    });
  }

  /**
   * Sensitive interactions (permission decisions, reconnect) require an
   * operator: DMs are always allowed; guild channels require `user.id` in
   * `allowedUserIds`.
   */
  private _isOperatorInteraction(cb: InboundCallback): boolean {
    if (cb.chatType === 'private') return true;
    return cb.fromId !== undefined && this.allowedUserIds.has(String(cb.fromId));
  }

  private async _onInteraction(cb: InboundCallback): Promise<void> {
    const interaction = cb.raw as ButtonInteraction;
    if (!interaction?.isButton?.()) return;
    const channelId = cb.chatId ? String(cb.chatId) : undefined;
    if (!channelId || !this._isAllowed(channelId)) return;

    const data = cb.data || '';
    const sensitive = data === 'reconnect' || data.startsWith('perm_');
    if (sensitive && !this._isOperatorInteraction(cb)) {
      await interaction.reply({ content: '⛔ Not authorized', ephemeral: true }).catch(() => {});
      log.warn(
        `Rejected ${data.split('_')[0]} interaction from user ${cb.fromId} in channel ${channelId}`
      );
      return;
    }
    if (data === 'reconnect') {
      try {
        await interaction.update({ content: '🔄 Reconnecting agent…', components: [] });
      } catch {
        // ignore
      }
      try {
        await this.acp.restart();
        const sessionNote = this.acp.sessionId
          ? `session \`${this.acp.sessionId}\``
          : 'new session';
        await interaction.editReply(`✅ Agent reconnected — ${sessionNote}`);
        log.info(`🔄 agent restarted, session: ${this.acp.sessionId}`);
      } catch (err) {
        await interaction.editReply(`❌ Reconnect failed: ${(err as Error).message}`);
      }
      return;
    }
    if (data.startsWith('perm_') && this.permissionPending) {
      if (String(cb.messageId) !== String(this.permissionPending.messageId)) {
        await interaction
          .reply({ content: '⌛ Permission request expired', ephemeral: true })
          .catch(() => {});
        return;
      }
      const [, outcome, ...rest] = data.split('_');
      const optionId = rest.join('_');
      const response: PermissionResponse = { outcome: { outcome: 'selected', optionId } };

      this.permissionPending.resolve(response);
      this.permissionPending = null;

      try {
        await interaction.update({
          content: `Permission: ${outcome === 'allow' ? 'Allowed' : 'Denied'}`,
          components: [],
        });
      } catch {
        // ignore
      }
    }
  }

  protected _sendTypingTo(channelId: string | number): void {
    if (!this.transport.typing) return;
    void this.transport.typing(channelId).then(([e]) => {
      if (e) log.debug(`typing indicator failed (${e.kind}): ${e.message}`);
    });
  }

  async notifyAgentExit(code: number | null): Promise<void> {
    const detail = code !== null ? ` (exit code ${code})` : '';
    for (const channelId of this.allowedChannelIds) {
      const [e] = await this.transport.send(
        channelId,
        `⚠️ Agent process exited${detail} — connection lost.`,
        { keyboard: [[{ text: '🔄 Reconnect', callback_data: 'reconnect', style: 'primary' }]] }
      );
      if (e) log.error(`Failed to notify channel ${channelId}:`, e.message);
    }
  }

  protected async _sendPlatformFile(
    channelId: string | number,
    filePath: string,
    caption?: string
  ): Promise<void> {
    if (!this.transport.sendFile) throw new Error('sendFile not supported by transport');
    this._must(
      await this.transport.sendFile(channelId, filePath, {
        caption: caption?.slice(0, DISCORD_MAX_LEN),
      })
    );
  }

  protected async _sendPlatformMessage(
    channelId: number | string,
    text: string,
    replyToId?: number | string
  ): Promise<{ messageId?: number | string }> {
    const r = this._must(
      await this.transport.send(channelId, text, {
        replyToId: replyToId !== undefined ? String(replyToId) : undefined,
      })
    );
    return { messageId: r.messageId };
  }
}
