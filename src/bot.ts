import type { ContentBlock } from '@agentclientprotocol/sdk';
import TelegramBot from 'node-telegram-bot-api';
import type { AcpClient } from './acp-client';
import type { PermissionResponse } from './base-bot';
import { BaseBot } from './base-bot';
import type { MediaHandler } from './media';

const TG_MAX_LEN = 4096;

export interface PlatformBot {
  start(): Promise<void>;
  stop(): void;
  enqueuePrompt(
    text: string,
    chatId?: number | string,
    blocks?: ContentBlock[],
    onComplete?: (response: string, error?: string) => void
  ): Promise<void>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  hasActivePrompt(): boolean;
  setMediaHandler(handler: MediaHandler): void;
  setCommandHandler(fn: ((text: string, chatId: number | string) => Promise<boolean>) | null): void;
}

interface BridgeBotOpts {
  acp: AcpClient;
  telegramToken: string;
  allowedChatIds: number[];
  agentCmd: string;
  showThoughts?: boolean;
  streaming?: boolean;
  mediaHandler?: MediaHandler | null;
  onCommand?: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt?: ((text: string, chatId: number | string) => void) | null;
}

export class BridgeBot extends BaseBot {
  private allowedChatIds: Set<number>;
  private bot: TelegramBot;

  protected readonly maxLen = TG_MAX_LEN;

  constructor({
    acp,
    telegramToken,
    allowedChatIds,
    agentCmd,
    showThoughts = false,
    streaming = true,
    mediaHandler = null,
    onCommand = null,
    onPrompt = null,
  }: BridgeBotOpts) {
    super({ acp, agentCmd, showThoughts, streaming, mediaHandler, onCommand, onPrompt });
    this.allowedChatIds = new Set(allowedChatIds);
    this.bot = new TelegramBot(telegramToken, { polling: true });
  }

  async start(): Promise<void> {
    this._setupHandlers();
  }

  stop(): void {
    if (this.bot) this.bot.stopPolling();
  }

  private _setupHandlers(): void {
    this.bot.on('message', (msg) => this._onMessage(msg));
    this.bot.on('callback_query', (query) => this._onCallbackQuery(query));
    this.bot.on('polling_error', (err) => console.error('TG polling error:', err.message));
  }

  private _isAllowed(chatId: number): boolean {
    return this.allowedChatIds.has(chatId);
  }

  protected _currentChannel(): string | number | null {
    return this.currentChannelId;
  }

  protected async _sendNewMessage(text: string): Promise<{ messageId: number | string }> {
    const chatId = this._currentChannel() as number;
    if (!chatId) throw new Error('No active chat');
    try {
      const sent = await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      return { messageId: sent.message_id };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('parse') || msg.includes('entity')) {
        const sent = await this.bot.sendMessage(chatId, text);
        return { messageId: sent.message_id };
      }
      throw err;
    }
  }

  protected async _editMessage(messageId: number | string, text: string): Promise<void> {
    const chatId = this._currentChannel() as number;
    if (!chatId) return;
    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId as number,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('parse') || msg.includes('entity')) {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId as number,
        });
      } else {
        throw err;
      }
    }
  }

  protected async _sendOverflowChunk(chunk: string): Promise<void> {
    const chatId = this._currentChannel() as number;
    if (!chatId) return;
    try {
      await this.bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('parse') || msg.includes('entity')) {
        try {
          await this._sendPlain(chunk);
        } catch {
          // ignore
        }
      }
    }
  }

  protected async _sendPlain(text: string): Promise<void> {
    const chatId = this._currentChannel() as number;
    if (!chatId) return;
    await this.bot.sendMessage(chatId, text);
  }

  private async _onMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (!this._isAllowed(chatId)) {
      console.log(`🚫 [${chatId}] ${this._sanitize(text)}`);
      if (this.allowedChatIds.size === 0) {
        await this.bot.sendMessage(
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

    if (
      !text &&
      (msg.photo || msg.voice || msg.sticker || msg.document || msg.video || msg.audio)
    ) {
      if (!this.mediaHandler) {
        await this.bot.sendMessage(chatId, 'Media no soportado');
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

    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    console.log(`👤 ${preview}${text.length > 80 ? '…' : ''}`);

    this.queue.push({ channelId: chatId, text });
    this._processQueue();
  }

  private async _handleMedia(msg: TelegramBot.Message, chatId: number): Promise<void> {
    if (!this.mediaHandler) return;

    let fileId: string | null = null;
    let mimeType = 'application/octet-stream';
    let ext = 'bin';

    if (msg.photo && msg.photo.length > 0) {
      // Use highest resolution
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      mimeType = 'image/jpeg';
      ext = 'jpg';
    } else if (msg.document) {
      fileId = msg.document.file_id;
      mimeType = msg.document.mime_type || 'application/octet-stream';
      ext = msg.document.file_name?.split('.').pop() || 'bin';
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      mimeType = 'image/webp';
      ext = 'webp';
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      mimeType = msg.voice.mime_type || 'audio/ogg';
      ext = 'ogg';
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      mimeType = msg.audio.mime_type || 'audio/mpeg';
      ext = 'mp3';
    } else if (msg.video) {
      fileId = msg.video.file_id;
      mimeType = msg.video.mime_type || 'video/mp4';
      ext = 'mp4';
    }

    if (!fileId) return;

    const caption = msg.caption || '';

    try {
      const link = await this.bot.getFileLink(fileId);
      const downloadFn = async () => {
        const res = await fetch(link);
        return Buffer.from(await res.arrayBuffer());
      };
      const blocks = await this.mediaHandler.processMedia(
        downloadFn,
        mimeType,
        ext,
        caption || undefined
      );
      const preview = caption ? `📷 ${caption.slice(0, 60)}` : `📷 ${mimeType}`;
      console.log(`👤 ${preview}`);
      this.queue.push({ channelId: chatId, text: caption || `[📄 file]`, blocks });
      this._processQueue();
    } catch (err) {
      console.error('Media download failed:', (err as Error).message);
      await this.bot.sendMessage(chatId, `Error downloading media: ${(err as Error).message}`);
    }
  }

  protected async _handleBuiltinCommand(text: string, chatId: string | number): Promise<boolean> {
    if (await this._handleSessionCommand(text, chatId)) return true;

    const cid = chatId as number;
    if (text === '/stop') {
      if (!this.busy) {
        await this.bot.sendMessage(cid, 'Nothing to stop.');
        return true;
      }
      try {
        await this.acp.cancel();
        this.queue = [];
        await this.bot.sendMessage(cid, '⏹ Stopped.');
        console.log('⏹ stop requested');
      } catch (err) {
        await this.bot.sendMessage(cid, `Stop failed: ${(err as Error).message}`);
      }
      return true;
    }

    if (text !== '/start' && text !== '/help') return false;
    await this.bot.sendMessage(
      cid,
      [
        '👋 *acp-connector*',
        '',
        "Send any message and I'll forward it to your coding agent.",
        '',
        '*Commands:*',
        '  /stop — cancel the current task',
        '  /new — start a fresh session (clears context)',
        '  /sessions — list available sessions',
        '  /session `<id>` — switch to an existing session',
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
        '',
        'Any other text is sent to the agent.',
        '',
        '📖 Docs: https://github.com/galiprandi/acp-connector#readme',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
    return true;
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

    const chatId = this.currentChannelId as number | null;
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

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.bot.sendMessage(chatId as number, text, { parse_mode: 'Markdown' });
  }
}
