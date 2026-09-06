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
import type { AcpClient } from './acp-client';
import type { PlatformBot } from './bot';
import type { MediaHandler } from './media';

const DISCORD_MAX_LEN = 2000;
const STREAM_BATCH_MS = 800;

interface DiscordBotOpts {
  acp: AcpClient;
  token: string;
  allowedChannelIds: string[];
  agentCmd: string;
  showThoughts?: boolean;
  streaming?: boolean;
  mediaHandler?: MediaHandler | null;
  onCommand?: ((text: string, chatId: string) => Promise<boolean>) | null;
  onPrompt?: ((text: string, chatId: string) => void) | null;
}

interface QueueItem {
  channelId: string;
  text: string;
  blocks?: ContentBlock[];
}

interface PermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

interface PermissionPending {
  resolve: (response: PermissionResponse) => void;
}

export class DiscordBot implements PlatformBot {
  private acp: AcpClient;
  private token: string;
  private allowedChannelIds: Set<string>;
  private agentCmd: string;
  private showThoughts: boolean;
  private streaming: boolean;
  private mediaHandler: MediaHandler | null;
  onCommand: ((text: string, chatId: string) => Promise<boolean>) | null;
  private onPrompt: ((text: string, chatId: string) => void) | null;
  private client: Client;
  private queue: QueueItem[];
  private busy: boolean;
  private currentMessage: Message | null;
  private streamBuffer: string;
  private streamTimer: NodeJS.Timeout | null;
  private streamDirty: boolean;
  private currentChannelId: string | null;
  private permissionPending: PermissionPending | null;

  constructor({
    acp,
    token,
    allowedChannelIds,
    agentCmd,
    showThoughts = false,
    streaming = true,
    mediaHandler = null,
    onCommand = null,
    onPrompt = null,
  }: DiscordBotOpts) {
    this.acp = acp;
    this.token = token;
    this.allowedChannelIds = new Set(allowedChannelIds.map(String));
    this.agentCmd = agentCmd;
    this.showThoughts = showThoughts;
    this.streaming = streaming;
    this.mediaHandler = mediaHandler;
    this.onCommand = onCommand;
    this.onPrompt = onPrompt;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.queue = [];
    this.busy = false;
    this.currentMessage = null;
    this.streamBuffer = '';
    this.streamTimer = null;
    this.streamDirty = false;
    this.currentChannelId = null;
    this.permissionPending = null;
  }

  async start(): Promise<void> {
    this._setupHandlers();
    await this.client.login(this.token);
  }

  private _setupHandlers(): void {
    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg));
    this.client.on(Events.InteractionCreate, (interaction) =>
      this._onInteraction(interaction as ButtonInteraction)
    );
    this.client.on(Events.Error, (err) => console.error('Discord error:', err.message));
  }

  private _isAllowed(channelId: string): boolean {
    return this.allowedChannelIds.has(channelId);
  }

  private _sanitize(text: string, maxLen = 80): string {
    return (
      text
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char stripping for safe logging
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, maxLen)
    );
  }

  private async _onMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;

    const channelId = msg.channel.id;
    const text = msg.content || '';

    if (!this._isAllowed(channelId)) {
      console.log(`🚫 [${channelId}] ${this._sanitize(text)}`);
      if (this.allowedChannelIds.size === 0) {
        (msg.channel as TextChannel).send(
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
    console.log(`👤 ${preview}${text.length > 80 ? '…' : ''}`);

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
      console.log(`👤 ${preview}`);
      this.queue.push({ channelId, text: caption || '[📄 file]', blocks: allBlocks });
      this._processQueue();
    } catch (err) {
      console.error('Discord media download failed:', (err as Error).message);
      const channel = this.client.channels.cache.get(channelId) as TextChannel;
      await channel?.send(`Error downloading media: ${(err as Error).message}`);
    }
  }

  async enqueuePrompt(
    text: string,
    chatId?: number | string,
    blocks?: ContentBlock[]
  ): Promise<void> {
    if (!chatId) return;
    const channelId = String(chatId);
    if (await this._handleBuiltinCommand(text, channelId)) return;
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, channelId);
      if (handled) return;
    }
    this.queue.push({ channelId, text, blocks });
    this._processQueue();
  }

  private async _handleBuiltinCommand(text: string, channelId: string): Promise<boolean> {
    if (text !== '/start' && text !== '/help') return false;
    (this.client.channels.cache.get(channelId) as TextChannel)?.send(
      [
        '👋 **acp-connector**',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '**Commands:**',
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
        '',
        'Any other text is sent to the agent.',
        '',
        '📖 Docs: https://github.com/galiprandi/acp-connector#readme',
      ].join('\n')
    );
    return true;
  }

  private async _processQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

    // biome-ignore lint/style/noNonNullAssertion: queue is non-empty (checked above)
    const { channelId, text, blocks } = this.queue.shift()!;
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessage = null;
    this.streamDirty = false;
    this.currentChannelId = channelId;

    if (this.onPrompt) this.onPrompt(text, channelId);

    try {
      this.acp.prompt(blocks || text);

      // biome-ignore lint/suspicious/noExplicitAny: SDK update types are complex and dynamic
      let message: any = null;
      for (;;) {
        message = await this.acp.nextUpdate();
        if (message.kind === 'stop') break;
        if (message.update) this._handleUpdate(message.update);
      }

      this._flushStream();
      await this._flushOverflow();

      const respLen = this.streamBuffer.length;
      const respPreview = this.streamBuffer.slice(0, 80).replace(/\n/g, ' ');
      console.log(`🤖 ${respPreview}${respLen > 80 ? '…' : ''}`);

      if (!this.streamBuffer && this.currentChannelId) {
        const stopReason = message?.stopReason;
        if (stopReason && stopReason !== 'end_turn') {
          const channel = this.client.channels.cache.get(this.currentChannelId) as TextChannel;
          await channel?.send(`[${stopReason}]`);
        }
      }
    } catch (err) {
      const channel = this.client.channels.cache.get(channelId) as TextChannel;
      await channel?.send(`Error: ${(err as Error).message}`);
    }

    this.busy = false;
    this.currentMessage = null;
    this.streamBuffer = '';
    this._processQueue();
  }

  // biome-ignore lint/suspicious/noExplicitAny: SDK update types are complex and dynamic
  private _handleUpdate(update: any): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') {
          this.streamBuffer += update.content.text;
          this.streamDirty = true;
          if (this.streaming) this._scheduleStreamFlush();
        }
        break;
      case 'agent_message':
        if (Array.isArray(update.content)) {
          this.streamBuffer = update.content
            .map(
              // biome-ignore lint/suspicious/noExplicitAny: SDK content type
              (c: any) => c.text || ''
            )
            .join('');
        } else if (update.content?.text) {
          this.streamBuffer = update.content.text;
        }
        this.streamDirty = true;
        if (this.streaming) this._scheduleStreamFlush();
        break;
      case 'agent_thought_chunk':
        if (this.showThoughts && update.content?.type === 'text') {
          this.streamBuffer += update.content.text;
          this.streamDirty = true;
          if (this.streaming) this._scheduleStreamFlush();
        }
        break;
      case 'agent_thought':
        if (this.showThoughts) {
          const thoughtText = Array.isArray(update.content)
            ? update.content
                .map(
                  // biome-ignore lint/suspicious/noExplicitAny: SDK content type
                  (c: any) => c.text || ''
                )
                .join('')
            : update.content?.text || '';
          if (thoughtText) {
            this.streamBuffer += thoughtText;
            this.streamDirty = true;
            if (this.streaming) this._scheduleStreamFlush();
          }
        }
        break;
      default:
        break;
    }
  }

  private _scheduleStreamFlush(): void {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this._flushStream();
    }, STREAM_BATCH_MS);
  }

  private async _flushStream(): Promise<void> {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (!this.streamDirty || !this.streamBuffer) return;
    this.streamDirty = false;

    const text = this.streamBuffer.slice(0, DISCORD_MAX_LEN);
    const channelId = this.currentChannelId;
    if (!channelId) return;

    try {
      if (!this.currentMessage) {
        const channel = this.client.channels.cache.get(channelId) as TextChannel;
        this.currentMessage = await channel?.send(text);
      } else {
        await this.currentMessage.edit(text);
      }
    } catch {
      // Discord edit failures are non-fatal
    }
  }

  private async _flushOverflow(): Promise<void> {
    const text = this.streamBuffer;
    const channelId = this.currentChannelId;
    if (!channelId || text.length <= DISCORD_MAX_LEN) return;

    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) return;

    for (let i = DISCORD_MAX_LEN; i < text.length; i += DISCORD_MAX_LEN) {
      const chunk = text.slice(i, i + DISCORD_MAX_LEN);
      try {
        await channel.send(chunk);
      } catch {
        // ignore
      }
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types are complex
  async _handlePermission(params: any): Promise<any> {
    const cmd = (this.agentCmd || '').toLowerCase();
    if (cmd.includes('dangerous') || cmd.includes('bypass') || cmd.includes('yolo')) {
      console.log('⚡ auto-approved');
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

    const channelId = this.currentChannelId;
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
    console.log(`🔐 permiso: ${desc.slice(0, 60)}`);

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
            .setLabel('Permitir')
            .setStyle(ButtonStyle.Success)
        );
      }
      if (rejectOpt) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`perm_deny_${rejectOpt.optionId}`)
            .setLabel('Denegar')
            .setStyle(ButtonStyle.Danger)
        );
      }

      await channel.send({ content: `Permiso requerido:\n\n${desc}`, components: [row] });

      return new Promise<PermissionResponse>((resolve) => {
        this.permissionPending = { resolve };
      });
    } catch (err) {
      console.error('Discord permission send failed:', (err as Error).message);
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

  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types vary
  private _formatPermission(params: any): string {
    const parts: string[] = [];
    const tc = params.toolCall || {};
    if (tc.title) parts.push(`Tool: ${tc.title}`);
    if (tc.name) parts.push(`Tool: ${tc.name}`);
    if (tc.status) parts.push(`Status: ${tc.status}`);
    if (tc.toolCallId && !tc.title && !tc.name) parts.push(`Call: ${tc.toolCallId}`);
    if (parts.length === 0) parts.push(JSON.stringify(params).slice(0, 500));
    return parts.join('\n');
  }

  private async _onInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.isButton()) return;
    const channelId = interaction.channel?.id;
    if (!channelId || !this._isAllowed(channelId)) return;

    const data = interaction.customId || '';
    if (data.startsWith('perm_') && this.permissionPending) {
      const [, outcome, ...rest] = data.split('_');
      const optionId = rest.join('_');
      const response: PermissionResponse = { outcome: { outcome: 'selected', optionId } };

      this.permissionPending.resolve(response);
      this.permissionPending = null;

      try {
        await interaction.update({
          content: `Permiso: ${outcome === 'allow' ? 'Permitido' : 'Denegado'}`,
          components: [],
        });
      } catch {
        // ignore
      }
    }
  }

  async sendMessage(channelId: number | string, text: string): Promise<void> {
    const channel = this.client.channels.cache.get(String(channelId)) as TextChannel;
    await channel?.send(text);
  }

  stop(): void {
    if (this.client) this.client.destroy();
  }
}
