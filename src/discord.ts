import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { AcpClient } from './acp-client.js';
import type { PermissionResponse } from './base-bot.js';
import { BaseBot } from './base-bot.js';
import { log } from './logger.js';
import type { MediaHandler } from './media.js';

const DISCORD_MAX_LEN = 2000;

interface DiscordBotOpts {
  acp: AcpClient;
  token: string;
  allowedChannelIds: string[];
  agentCmd: string;
  showThoughts?: boolean;
  showTools?: boolean;
  showPlan?: boolean;
  streaming?: boolean;
  mediaHandler?: MediaHandler | null;
  onCommand?: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt?: ((text: string, chatId: number | string) => void) | null;
}

export class DiscordBot extends BaseBot {
  private token: string;
  private allowedChannelIds: Set<string>;
  private client: Client;
  private currentMessage: Message | null;

  protected readonly maxLen = DISCORD_MAX_LEN;

  constructor({
    acp,
    token,
    allowedChannelIds,
    agentCmd,
    showThoughts = false,
    showTools = true,
    showPlan = true,
    streaming = true,
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
      mediaHandler,
      onCommand,
      onPrompt,
    });
    this.token = token;
    this.allowedChannelIds = new Set(allowedChannelIds.map(String));
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
    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg));
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

  protected async _sendPlain(text: string): Promise<void> {
    const channelId = this._currentChannel() as string;
    if (!channelId) return;
    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    await channel?.send(text);
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

    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    log.info(`👤 ${preview}${text.length > 80 ? '…' : ''}`);

    this.queue.push({ channelId, text });
    this._processQueue();
  }

  private async _handleDiscordMedia(msg: Message, channelId: string): Promise<void> {
    if (!this.mediaHandler) return;
    const caption = msg.content || '';

    try {
      const allBlocks: ContentBlock[] = [];
      for (const [, attachment] of msg.attachments) {
        const mimeType = attachment.contentType || 'application/octet-stream';
        const ext = attachment.name?.split('.').pop() || 'bin';
        const downloadFn = async () => {
          const res = await fetch(attachment.url);
          return Buffer.from(await res.arrayBuffer());
        };
        const blocks = await this.mediaHandler.processMedia(downloadFn, mimeType, ext);
        allBlocks.push(...blocks);
      }
      if (caption) {
        allBlocks.push({ type: 'text', text: caption } as ContentBlock);
      }
      const preview = caption ? `📷 ${caption.slice(0, 60)}` : `📷 ${msg.attachments.size} file(s)`;
      log.info(`👤 ${preview}`);
      this.queue.push({ channelId, text: caption || '[📄 file]', blocks: allBlocks });
      this._processQueue();
    } catch (err) {
      log.error('Discord media download failed:', (err as Error).message);
      const channel = this.client.channels.cache.get(channelId) as TextChannel;
      await channel?.send(`Error downloading media: ${(err as Error).message}`);
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
    await (this.client.channels.cache.get(cid) as TextChannel)?.send(
      [
        '👋 **acp-connector**',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '**Commands:**',
        '  /stop — cancel the current task',
        '  /new — start a fresh session (clears context)',
        '  /sessions — list available sessions',
        '  /session `<id>` — switch to an existing session',
        '  /delete `<id>` — delete a session',
        '  /mode — list available session modes',
        '  /mode `<id>` — switch session mode (e.g. /mode bypass)',
        '  /config — list session config options',
        '  /config `<id> [value]` — show or set an option',
        '  /model `[value]` — show or set the model',
        '',
        '  /cron list — list scheduled jobs',
        '  /cron add `<schedule> <prompt>` — add a job',
        '  /cron remove `<name>` — remove a job',
        '  /cron toggle `<name>` — pause/activate',
        '  /cron run `<name>` — run now',
        '',
        '  /routine list — list routines',
        '  /routine add `<name> <prompt>` — add a routine',
        '  /routine remove `<name>` — remove a routine',
        '',
        '  /run `<name>` — run a routine',
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

      await channel.send({ content: `Permission required:\n\n${desc}`, components: [row] });

      return new Promise<PermissionResponse>((resolve) => {
        this.permissionPending = { resolve };
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

  private async _onInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const channelId = interaction.channel?.id;
    if (!channelId || !this._isAllowed(channelId)) return;

    const data = interaction.customId || '';
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

  async sendMessage(channelId: number | string, text: string): Promise<void> {
    const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
    await channel?.send(text);
  }
}
