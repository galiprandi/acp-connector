import TelegramBot from 'node-telegram-bot-api';
import type { AcpClient } from './acp-client';

const TG_MAX_LEN = 4096;
const STREAM_BATCH_MS = 800;

export interface PlatformBot {
  start(): Promise<void>;
  stop(): void;
  enqueuePrompt(text: string, chatId?: number): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

interface BridgeBotOpts {
  acp: AcpClient;
  telegramToken: string;
  allowedChatIds: number[];
  agentCmd: string;
  showThoughts?: boolean;
  streaming?: boolean;
  onCommand?: ((text: string, chatId: number) => Promise<boolean>) | null;
  onPrompt?: ((text: string, chatId: number) => void) | null;
}

interface QueueItem {
  chatId: number;
  text: string;
}

interface PermissionOption {
  optionId: string;
  kind: string;
  title?: string;
  description?: string;
}

interface PermissionParams {
  options?: PermissionOption[];
  toolCall?: {
    title?: string;
    status?: string;
  };
}

interface PermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

interface SessionUpdate {
  sessionUpdate: string;
  content?: Content | Content[];
}

interface Content {
  type: string;
  text: string;
}

interface PermissionPending {
  resolve: (response: PermissionResponse) => void;
}

export class BridgeBot implements PlatformBot {
  private acp: AcpClient;
  private allowedChatIds: Set<number>;
  private agentCmd: string;
  private showThoughts: boolean;
  private streaming: boolean;
  onCommand: ((text: string, chatId: number) => Promise<boolean>) | null;
  private onPrompt: ((text: string, chatId: number) => void) | null;
  private bot: TelegramBot;
  private queue: QueueItem[];
  private busy: boolean;
  private currentMessageId: number | null;
  private streamBuffer: string;
  private streamTimer: NodeJS.Timeout | null;
  private streamDirty: boolean;
  private currentChatId: number | null;
  private permissionPending: PermissionPending | null;

  constructor({
    acp,
    telegramToken,
    allowedChatIds,
    agentCmd,
    showThoughts = false,
    streaming = true,
    onCommand = null,
    onPrompt = null,
  }: BridgeBotOpts) {
    this.acp = acp;
    this.allowedChatIds = new Set(allowedChatIds);
    this.agentCmd = agentCmd;
    this.showThoughts = showThoughts;
    this.streaming = streaming;
    this.onCommand = onCommand;
    this.onPrompt = onPrompt;

    this.bot = new TelegramBot(telegramToken, { polling: true });
    this.queue = [];
    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this.streamTimer = null;
    this.streamDirty = false;
    this.currentChatId = null;
    this.permissionPending = null;
  }

  async start(): Promise<void> {
    this._setupHandlers();
  }

  private _setupHandlers(): void {
    this.bot.on('message', (msg) => this._onMessage(msg));
    this.bot.on('callback_query', (query) => this._onCallbackQuery(query));
    this.bot.on('polling_error', (err) => console.error('TG polling error:', err.message));
  }

  private _isAllowed(chatId: number): boolean {
    return this.allowedChatIds.has(chatId);
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

  private async _onMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (!this._isAllowed(chatId)) {
      console.log(`🚫 [${chatId}] ${this._sanitize(text)}`);
      if (this.allowedChatIds.size === 0) {
        this.bot.sendMessage(
          chatId,
          [
            `Your chat ID is: ${chatId}`,
            '',
            'To allow this chat, add it to .config.jsonc:',
            '',
            `  "allowedChatIds": [${chatId}]`,
            '',
            'Then restart the bridge.',
          ].join('\n')
        );
      }
      return;
    }

    if (
      !text &&
      (msg.photo || msg.voice || msg.sticker || msg.document || msg.video || msg.audio)
    ) {
      this.bot.sendMessage(chatId, 'solo texto por ahora');
      return;
    }

    if (await this._handleBuiltinCommand(text, chatId)) return;

    if (!text || text.trim() === '') return;

    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }

    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    console.log(`👤 ${preview}${text.length > 80 ? '…' : ''}`);

    this.queue.push({ chatId, text });
    this._processQueue();
  }

  async enqueuePrompt(text: string, chatId?: number): Promise<void> {
    if (!chatId) return;
    if (await this._handleBuiltinCommand(text, chatId)) return;
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }
    this.queue.push({ chatId, text });
    this._processQueue();
  }

  private async _handleBuiltinCommand(text: string, chatId: number): Promise<boolean> {
    if (text !== '/start' && text !== '/help') return false;
    this.bot.sendMessage(
      chatId,
      [
        '👋 *acp-connector*',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '*Commands:*',
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
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  private async _processQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

    // biome-ignore lint/style/noNonNullAssertion: queue is non-empty (checked above)
    const { chatId, text } = this.queue.shift()!;
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessageId = null;
    this.streamDirty = false;
    this.currentChatId = chatId;

    if (this.onPrompt) this.onPrompt(text, chatId);

    try {
      this.acp.prompt(text);

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

      if (!this.streamBuffer && this.currentChatId) {
        const stopReason = message?.stopReason;
        if (stopReason && stopReason !== 'end_turn') {
          this.bot.sendMessage(this.currentChatId, `[${stopReason}]`);
        }
      }
    } catch (err) {
      this.bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
    }

    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this._processQueue();
  }

  private _handleUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (
          update.content &&
          typeof update.content === 'object' &&
          !Array.isArray(update.content)
        ) {
          const c = update.content as Content;
          if (c.type === 'text') {
            this.streamBuffer += c.text;
            this.streamDirty = true;
            if (this.streaming) this._scheduleStreamFlush();
          }
        }
        break;
      case 'agent_message':
        if (Array.isArray(update.content)) {
          this.streamBuffer = update.content.map((c) => c.text || '').join('');
        } else if (update.content && (update.content as Content).text) {
          this.streamBuffer = (update.content as Content).text;
        }
        this.streamDirty = true;
        if (this.streaming) this._scheduleStreamFlush();
        break;
      case 'agent_thought_chunk':
        if (
          this.showThoughts &&
          update.content &&
          typeof update.content === 'object' &&
          !Array.isArray(update.content)
        ) {
          const c = update.content as Content;
          if (c.type === 'text') {
            this.streamBuffer += c.text;
            this.streamDirty = true;
            if (this.streaming) this._scheduleStreamFlush();
          }
        }
        break;
      case 'agent_thought':
        if (this.showThoughts) {
          const thoughtText = Array.isArray(update.content)
            ? update.content.map((c) => c.text || '').join('')
            : (update.content as Content)?.text || '';
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

    const text = this.streamBuffer.slice(0, TG_MAX_LEN);
    const chatId = this.currentChatId;
    if (!chatId) return;

    try {
      if (!this.currentMessageId) {
        const sent = await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        this.currentMessageId = sent.message_id;
      } else {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: this.currentMessageId,
          parse_mode: 'Markdown',
        });
      }
    } catch (err) {
      if ((err as Error).message.includes('parse') || (err as Error).message.includes('entity')) {
        try {
          if (this.currentMessageId) {
            await this.bot.editMessageText(text, {
              chat_id: chatId,
              message_id: this.currentMessageId,
            });
          } else {
            const sent = await this.bot.sendMessage(chatId, text);
            this.currentMessageId = sent.message_id;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private async _flushOverflow(): Promise<void> {
    const text = this.streamBuffer;
    const chatId = this.currentChatId;
    if (!chatId || text.length <= TG_MAX_LEN) return;

    const chunks: string[] = [];
    for (let i = TG_MAX_LEN; i < text.length; i += TG_MAX_LEN) {
      chunks.push(text.slice(i, i + TG_MAX_LEN));
    }

    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch (err) {
        if ((err as Error).message.includes('parse') || (err as Error).message.includes('entity')) {
          try {
            await this.bot.sendMessage(chatId, chunk);
          } catch {
            // ignore
          }
        }
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

    const chatId = this.currentChatId;
    if (!chatId) {
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
      const allowOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('allow')
      );
      const rejectOpt = params.options?.find(
        // biome-ignore lint/suspicious/noExplicitAny: SDK option type
        (o: any) => o.kind.startsWith('reject')
      );
      const buttons: { text: string; callback_data: string }[] = [];
      if (allowOpt)
        buttons.push({ text: 'Permitir', callback_data: `perm_allow_${allowOpt.optionId}` });
      if (rejectOpt)
        buttons.push({ text: 'Denegar', callback_data: `perm_deny_${rejectOpt.optionId}` });

      await this.bot.sendMessage(chatId, `Permiso requerido:\n\n${desc}`, {
        reply_markup: { inline_keyboard: [buttons] },
      });

      return new Promise<PermissionResponse>((resolve) => {
        this.permissionPending = { resolve };
      });
    } catch {
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

  private _formatPermission(params: PermissionParams): string {
    const parts: string[] = [];
    if (params.toolCall?.title) parts.push(`Tool: ${params.toolCall.title}`);
    if (params.toolCall?.status) parts.push(`Status: ${params.toolCall.status}`);
    if (parts.length === 0) parts.push(JSON.stringify(params).slice(0, 500));
    return parts.join('\n');
  }

  private async _onCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat?.id;
    if (!chatId || !this._isAllowed(chatId)) return;

    const data = query.data || '';
    if (data.startsWith('perm_') && this.permissionPending) {
      const [, outcome, ...rest] = data.split('_');
      const optionId = rest.join('_');
      const response: PermissionResponse = { outcome: { outcome: 'selected', optionId } };

      this.permissionPending.resolve(response);
      this.permissionPending = null;

      try {
        await this.bot.editMessageText(
          `Permiso: ${outcome === 'allow' ? 'Permitido' : 'Denegado'}`,
          {
            chat_id: chatId,
            message_id: query.message?.message_id,
          }
        );
      } catch {
        // ignore
      }

      this.bot.answerCallbackQuery(query.id);
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  stop(): void {
    if (this.bot) this.bot.stopPolling();
  }
}
