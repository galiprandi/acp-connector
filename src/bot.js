import TelegramBot from 'node-telegram-bot-api';

const TG_MAX_LEN = 4096;
const STREAM_BATCH_MS = 800;

/**
 * Telegram bot bridge. Handles message routing, stream batching,
 * permissions, and bridge commands (/cron, /routine, /run).
 */
export class BridgeBot {
  /**
   * @param {Object} opts
   * @param {import('./acp-client.js').AcpClient} opts.acp
   * @param {string} opts.telegramToken
   * @param {number[]} opts.allowedChatIds
   * @param {string} opts.agentCmd
   * @param {boolean} [opts.showThoughts]
   * @param {boolean} [opts.streaming]
   * @param {Function} [opts.onCommand] - Bridge command handler (returns true if handled)
   * @param {Function} [opts.onPrompt] - Called when a prompt is enqueued
   */
  constructor({
    acp,
    telegramToken,
    allowedChatIds,
    agentCmd,
    showThoughts = false,
    streaming = true,
    onCommand = null,
    onPrompt = null,
  }) {
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

  async start() {
    this._setupHandlers();
  }

  _setupHandlers() {
    this.bot.on('message', (msg) => this._onMessage(msg));
    this.bot.on('callback_query', (query) => this._onCallbackQuery(query));
    this.bot.on('polling_error', (err) => console.error('TG polling error:', err.message));
  }

  _isAllowed(chatId) {
    return this.allowedChatIds.has(chatId);
  }

  _sanitize(text, maxLen = 80) {
    return (
      text
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char stripping for safe logging
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, maxLen)
    );
  }

  async _onMessage(msg) {
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

    // Built-in commands
    if (await this._handleBuiltinCommand(text, chatId)) return;

    // Ignore empty text
    if (!text || text.trim() === '') return;

    // Bridge commands (handled by onCommand if registered)
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }

    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    console.log(`👤 ${preview}${text.length > 80 ? '…' : ''}`);

    this.queue.push({ chatId, text });
    this._processQueue();
  }

  /**
   * Enqueue a prompt from an external source (cron, http, routines).
   * If the text is a bridge command (starts with /), it's handled by onCommand
   * instead of being sent to the agent.
   * @param {string} text
   * @param {number} chatId
   */
  async enqueuePrompt(text, chatId) {
    if (await this._handleBuiltinCommand(text, chatId)) return;
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }
    this.queue.push({ chatId, text });
    this._processQueue();
  }

  async _handleBuiltinCommand(text, chatId) {
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

  async _processQueue() {
    if (this.busy || this.queue.length === 0) return;

    const { chatId, text } = this.queue.shift();
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessageId = null;
    this.streamDirty = false;
    this.currentChatId = chatId;

    if (this.onPrompt) this.onPrompt(text, chatId);

    try {
      this.acp.prompt(text);

      let message = null;
      for (;;) {
        message = await this.acp.nextUpdate();
        if (message.kind === 'stop') break;
        this._handleUpdate(message.update);
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
      this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }

    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this._processQueue();
  }

  _handleUpdate(update) {
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
          this.streamBuffer = update.content.map((c) => c.text || '').join('');
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
            ? update.content.map((c) => c.text || '').join('')
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

  _scheduleStreamFlush() {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this._flushStream();
    }, STREAM_BATCH_MS);
  }

  async _flushStream() {
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
      if (err.message.includes('parse') || err.message.includes('entity')) {
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

  async _flushOverflow() {
    const text = this.streamBuffer;
    const chatId = this.currentChatId;
    if (!chatId || text.length <= TG_MAX_LEN) return;

    const chunks = [];
    for (let i = TG_MAX_LEN; i < text.length; i += TG_MAX_LEN) {
      chunks.push(text.slice(i, i + TG_MAX_LEN));
    }

    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch (err) {
        if (err.message.includes('parse') || err.message.includes('entity')) {
          try {
            await this.bot.sendMessage(chatId, chunk);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  async _handlePermission(params) {
    const cmd = (this.agentCmd || '').toLowerCase();
    if (cmd.includes('dangerous') || cmd.includes('bypass') || cmd.includes('yolo')) {
      console.log('⚡ auto-approved');
      const allowOpt = params.options?.find((o) => o.kind.startsWith('allow'));
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    // No options — cancel immediately
    if (!params.options || params.options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const chatId = this.currentChatId;
    if (!chatId) {
      const allowOpt = params.options?.find((o) => o.kind.startsWith('allow'));
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    const desc = this._formatPermission(params);
    console.log(`🔐 permiso: ${desc.slice(0, 60)}`);

    try {
      const allowOpt = params.options?.find((o) => o.kind.startsWith('allow'));
      const rejectOpt = params.options?.find((o) => o.kind.startsWith('reject'));
      const buttons = [];
      if (allowOpt)
        buttons.push({ text: 'Permitir', callback_data: `perm_allow_${allowOpt.optionId}` });
      if (rejectOpt)
        buttons.push({ text: 'Denegar', callback_data: `perm_deny_${rejectOpt.optionId}` });

      await this.bot.sendMessage(chatId, `Permiso requerido:\n\n${desc}`, {
        reply_markup: { inline_keyboard: [buttons] },
      });

      return new Promise((resolve) => {
        this.permissionPending = { resolve };
      });
    } catch {
      const allowOpt = params.options?.find((o) => o.kind.startsWith('allow'));
      if (allowOpt) {
        return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  _formatPermission(params) {
    const parts = [];
    if (params.toolCall?.title) parts.push(`Tool: ${params.toolCall.title}`);
    if (params.toolCall?.status) parts.push(`Status: ${params.toolCall.status}`);
    if (parts.length === 0) parts.push(JSON.stringify(params).slice(0, 500));
    return parts.join('\n');
  }

  async _onCallbackQuery(query) {
    const chatId = query.message?.chat?.id;
    if (!this._isAllowed(chatId)) return;

    const data = query.data || '';
    if (data.startsWith('perm_') && this.permissionPending) {
      const [, outcome, ...rest] = data.split('_');
      const optionId = rest.join('_');
      const response = { outcome: { outcome: 'selected', optionId } };

      this.permissionPending.resolve(response);
      this.permissionPending = null;

      try {
        await this.bot.editMessageText(
          `Permiso: ${outcome === 'allow' ? 'Permitido' : 'Denegado'}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
          }
        );
      } catch {
        // ignore
      }

      this.bot.answerCallbackQuery(query.id);
    }
  }

  /**
   * Send a message to a specific chat.
   * @param {number} chatId
   * @param {string} text
   */
  async sendMessage(chatId, text) {
    return this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  stop() {
    if (this.bot) this.bot.stopPolling();
  }
}
