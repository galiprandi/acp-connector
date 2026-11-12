import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { AcpClient } from './acp-client.js';
import type { PermissionResponse } from './base-bot.js';
import { BaseBot } from './base-bot.js';
import { errorMessage, log } from './logger.js';
import { fetchBuffer, type MediaHandler } from './media.js';

const DISCORD_MAX_LEN = 2000;

interface DiscordBotOpts {
  acp: AcpClient;
  token: string;
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
}

export class DiscordBot extends BaseBot {
  private token: string;
  private allowedChannelIds: Set<string>;
  private allowedUserIds: Set<string>;
  private client: Client;
  private currentMessage: Message | null;

  protected readonly maxLen = DISCORD_MAX_LEN;

  constructor({
    acp,
    token,
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
    });
    this.token = token;
    this.allowedChannelIds = new Set(allowedChannelIds.map(String));
    this.allowedUserIds = new Set(allowedUserIds.map(String));
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.currentMessage = null;
  }

  async start(): Promise<void> {
    this._setupHandlers();
    await this.client.login(this.token);
  }

  stop(): void {
    if (this.client) this.client.destroy();
  }

  private _setupHandlers(): void {
    this.client.on(Events.MessageCreate, (msg) =>
      this._onMessage(msg).catch(async (err) => {
        log.error('Unhandled message error:', errorMessage(err));
        try {
          const channel = msg.channel as TextChannel;
          await channel?.send(`⚠️ ${errorMessage(err).slice(0, 200)}`);
        } catch {
          // best effort — never crash on error reporting
        }
      })
    );
    this.client.on(Events.InteractionCreate, (interaction) =>
      this._onInteraction(interaction as ButtonInteraction)
    );
    this.client.on(Events.Error, (err) => log.error('Discord error:', err.message));
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
    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) throw new Error('Channel not found');
    this.currentMessage = await channel.send(text);
    return { messageId: this.currentMessage.id };
  }

  protected async _editMessage(_messageId: number | string, text: string): Promise<void> {
    if (this.currentMessage) {
      await this.currentMessage.edit(text);
    }
  }

  protected async _sendOverflowChunk(chunk: string): Promise<void> {
    const channelId = this._currentChannel() as string;
    if (!channelId) return;
    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) return;
    try {
      await channel.send(chunk);
    } catch {
      // ignore
    }
  }

  protected async _sendPlain(text: string, chatId?: string | number): Promise<void> {
    const target = (chatId ?? this._currentChannel()) as string;
    if (!target) return;
    const channel = this.client.channels.cache.get(target) as TextChannel;
    await channel?.send(text);
  }

  protected async _addQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
    const message = await channel?.messages.fetch(String(messageId)).catch(() => null);
    await message?.react('⏳');
  }

  protected async _clearQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void> {
    const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
    const message = await channel?.messages.fetch(String(messageId)).catch(() => null);
    await message?.reactions.cache.get('⏳')?.users.remove(this.client.user?.id);
  }

  private async _onMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;

    const channelId = msg.channel.id;
    const text = msg.content || '';

    if (!this._isAllowed(channelId)) {
      log.info(`🚫 [${channelId}] ${this._sanitize(text)}`);
      if (this.allowedChannelIds.size === 0) {
        await (msg.channel as TextChannel).send(
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
    if (msg.attachments && msg.attachments.size > 0 && this.mediaHandler) {
      await this._handleDiscordMedia(msg, channelId);
      return;
    }

    if (!text || text.trim() === '') return;

    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, channelId);
      if (handled) return;
    }

    const preview = text.slice(0, this.previewLength).replace(/\n/g, ' ');
    log.info(`👤 ${preview}${text.length > this.previewLength ? '…' : ''}`);

    const context = await this._replyContext(msg);
    this._enqueueUserMessage(channelId, msg.id, `${context}${text}`);
  }

  private async _replyContext(msg: Message): Promise<string> {
    if (!msg.reference?.messageId) return '';
    const ref = await msg.fetchReference().catch(() => null);
    const quote = (ref?.content || '').trim();
    if (!ref || !quote) return '';
    const author = ref.author?.username ? ` @${ref.author.username}` : '';
    const snippet = quote.slice(0, 300).replace(/\n/g, ' ');
    const suffix = quote.length > 300 ? '…' : '';
    return `[in reply to${author}: "${snippet}${suffix}"] `;
  }

  private async _handleDiscordMedia(msg: Message, channelId: string): Promise<void> {
    if (!this.mediaHandler) return;
    const caption = msg.content || '';

    try {
      const allBlocks: ContentBlock[] = [];
      for (const [, attachment] of msg.attachments) {
        const mimeType = attachment.contentType || 'application/octet-stream';
        const ext = attachment.name?.split('.').pop() || 'bin';
        const downloadFn = () => fetchBuffer(attachment.url);
        const blocks = await this.mediaHandler.processMedia(downloadFn, mimeType, ext);
        allBlocks.push(...blocks);
      }
      if (caption) {
        allBlocks.push({ type: 'text', text: caption } as ContentBlock);
      }
      const preview = caption ? `📷 ${caption.slice(0, 60)}` : `📷 ${msg.attachments.size} file(s)`;
      log.info(`👤 ${preview}`);
      const context = await this._replyContext(msg);
      this._enqueueUserMessage(channelId, msg.id, `${context}${caption || '[📄 file]'}`, allBlocks);
    } catch (err) {
      log.error('Discord media download failed:', errorMessage(err));
      const channel = this.client.channels.cache.get(channelId) as TextChannel;
      await channel?.send(`Error downloading media: ${errorMessage(err)}`);
    }
  }

  protected async _handleBuiltinCommand(
    text: string,
    channelId: string | number
  ): Promise<boolean> {
    if (await this._handleSessionCommand(text, channelId)) return true;

    const cid = String(channelId);
    if (text === '/stop') {
      const channel = this.client.channels.cache.get(cid) as TextChannel;
      if (!this.busy) {
        await channel?.send('Nothing to stop.');
        return true;
      }
      try {
        await this.acp.cancel();
        this.queue = [];
        await channel?.send('⏹ Stopped.');
        log.info('⏹ stop requested');
      } catch (err) {
        await channel?.send(`Stop failed: ${(err as Error).message}`);
      }
      return true;
    }

    if (text !== '/start' && text !== '/help') return false;
    const agentCommandLines = this._agentCommandsHelpLines();
    const agentSection =
      agentCommandLines.length > 0 ? ['', '**Agent commands:**', ...agentCommandLines] : [];
    await this.sendMessage(
      cid,
      [
        '👋 **acp-connector**',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '**Commands:**',
        ...this._bridgeCommandHelpLines(),
        ...agentSection,
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
    const cmd = (this.agentCmd || '').toLowerCase();
    if (cmd.includes('dangerous') || cmd.includes('bypass') || cmd.includes('yolo')) {
      log.info('⚡ auto-approved');
      const allowOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('allow')
      );
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    if (!params.options || params.options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const channelId = this.currentChannelId as string | null;
    if (!channelId) {
      const allowOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('allow')
      );
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    const desc = this._formatPermission(params);
    log.info(`🔐 permiso: ${desc.slice(0, 60)}`);

    try {
      const channel = this.client.channels.cache.get(channelId) as TextChannel;
      if (!channel) {
        const allowOpt = params.options?.find(
          // biome-ignore lint/suspicious/noExplicitAny: SDK option type
          (o: any) => o.kind.startsWith('allow')
        );
        if (allowOpt) return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
        return { outcome: { outcome: 'cancelled' } };
      }

      const allowOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('allow')
      );
      const rejectOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('reject')
      );

      const row = new ActionRowBuilder<ButtonBuilder>();
      if (allowOpt) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`perm_allow_${allowOpt.optionId}`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success)
        );
      }
      if (rejectOpt) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`perm_deny_${rejectOpt.optionId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger)
        );
      }

      const content = `Permission required:\n\n${desc}`.slice(0, DISCORD_MAX_LEN);
      const msg = await channel.send({ content, components: [row] });

      return new Promise<PermissionResponse>((resolve) => {
        this.permissionPending = { resolve, messageId: msg.id };
      });
    } catch (err) {
      log.error('Discord permission send failed:', (err as Error).message);
      const allowOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('allow')
      );
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  /**
   * Sensitive interactions (permission decisions, reconnect) require an
   * operator: DMs are always allowed; guild channels require `user.id` in
   * `allowedUserIds`.
   */
  private _isOperatorInteraction(interaction: ButtonInteraction): boolean {
    const type = interaction.channel?.type;
    if (type === ChannelType.DM || type === ChannelType.GroupDM) return true;
    const userId = interaction.user?.id;
    return userId !== undefined && this.allowedUserIds.has(String(userId));
  }

  private async _onInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const channelId = interaction.channel?.id;
    if (!channelId || !this._isAllowed(channelId)) return;

    const data = interaction.customId || '';
    const sensitive = data === 'reconnect' || data.startsWith('perm_');
    if (sensitive && !this._isOperatorInteraction(interaction)) {
      await interaction.reply({ content: '⛔ Not authorized', ephemeral: true }).catch(() => {});
      log.warn(
        `Rejected ${data.split('_')[0]} interaction from user ${interaction.user?.id} in channel ${channelId}`
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
      if (interaction.message?.id !== this.permissionPending.messageId) {
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

  protected _sendTypingIndicator(): void {
    const channelId = this._currentChannel();
    if (!channelId) return;
    try {
      const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
      channel?.sendTyping().catch(() => {});
    } catch {
      // typing indicator is best-effort
    }
  }

  async notifyAgentExit(code: number | null): Promise<void> {
    const detail = code !== null ? ` (exit code ${code})` : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('reconnect')
        .setLabel('🔄 Reconnect')
        .setStyle(ButtonStyle.Primary)
    );
    for (const channelId of this.allowedChannelIds) {
      try {
        const channel = this.client.channels.cache.get(channelId) as TextChannel;
        await channel?.send({
          content: `⚠️ Agent process exited${detail} — connection lost.`,
          components: [row],
        });
      } catch (err) {
        log.error(`Failed to notify channel ${channelId}:`, (err as Error).message);
      }
    }
  }

  protected async _sendPlatformMessage(
    channelId: number | string,
    text: string,
    replyToId?: number | string
  ): Promise<{ messageId?: number | string }> {
    const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
    const msg = await channel?.send({
      content: text,
      ...(replyToId !== undefined
        ? {
            reply: { messageReference: String(replyToId), failIfNotExists: false },
            allowedMentions: { repliedUser: false },
          }
        : {}),
    });
    return { messageId: msg?.id };
  }
}
