import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client';
import type { PlatformBot } from './bot';
import type { MediaHandler } from './media';

const STREAM_BATCH_MS = 800;

export interface BaseBotOpts {
  acp: AcpClient;
  agentCmd: string;
  showThoughts: boolean;
  streaming: boolean;
  mediaHandler: MediaHandler | null;
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt: ((text: string, chatId: number | string) => void) | null;
}

export interface QueueItem {
  channelId: string | number;
  text: string;
  blocks?: ContentBlock[];
}

export interface PermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

export interface PermissionPending {
  resolve: (response: PermissionResponse) => void;
}

export abstract class BaseBot implements PlatformBot {
  protected acp: AcpClient;
  protected agentCmd: string;
  protected showThoughts: boolean;
  protected streaming: boolean;
  protected mediaHandler: MediaHandler | null;
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  protected onPrompt: ((text: string, chatId: number | string) => void) | null;
  protected queue: QueueItem[];
  protected busy: boolean;
  protected currentMessageId: number | string | null;
  protected streamBuffer: string;
  protected streamTimer: NodeJS.Timeout | null;
  protected streamDirty: boolean;
  protected currentChannelId: string | number | null;
  protected permissionPending: PermissionPending | null;

  protected abstract readonly maxLen: number;

  protected constructor({
    acp,
    agentCmd,
    showThoughts,
    streaming,
    mediaHandler,
    onCommand,
    onPrompt,
  }: BaseBotOpts) {
    this.acp = acp;
    this.agentCmd = agentCmd;
    this.showThoughts = showThoughts;
    this.streaming = streaming;
    this.mediaHandler = mediaHandler;
    this.onCommand = onCommand;
    this.onPrompt = onPrompt;
    this.queue = [];
    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this.streamTimer = null;
    this.streamDirty = false;
    this.currentChannelId = null;
    this.permissionPending = null;
  }

  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract sendMessage(chatId: number | string, text: string): Promise<void>;

  protected abstract _sendNewMessage(text: string): Promise<{ messageId: number | string }>;
  protected abstract _editMessage(messageId: number | string, text: string): Promise<void>;
  protected abstract _sendOverflowChunk(chunk: string): Promise<void>;
  protected abstract _sendPlain(text: string): Promise<void>;
  protected abstract _currentChannel(): string | number | null;
  protected abstract _handleBuiltinCommand(
    text: string,
    channelId: string | number
  ): Promise<boolean>;

  setMediaHandler(handler: MediaHandler): void {
    this.mediaHandler = handler;
  }

  setCommandHandler(
    fn: ((text: string, chatId: number | string) => Promise<boolean>) | null
  ): void {
    this.onCommand = fn;
  }

  hasActivePrompt(): boolean {
    return this.currentChannelId !== null;
  }

  protected _sanitize(text: string, maxLen = 80): string {
    return (
      text
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char stripping for safe logging
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, maxLen)
    );
  }

  async enqueuePrompt(
    text: string,
    chatId?: number | string,
    blocks?: ContentBlock[]
  ): Promise<void> {
    if (!chatId) return;
    if (await this._handleBuiltinCommand(text, chatId)) return;
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }
    this.queue.push({ channelId: chatId, text, blocks });
    this._processQueue();
  }

  protected async _processQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

    // biome-ignore lint/style/noNonNullAssertion: queue is non-empty (checked above)
    const { channelId, text, blocks } = this.queue.shift()!;
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessageId = null;
    this.streamDirty = false;
    this.currentChannelId = channelId;

    if (this.onPrompt) this.onPrompt(text, channelId);

    try {
      await this.acp.prompt(blocks || text);

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
          await this._sendPlain(`[${stopReason}]`);
        }
      }
    } catch (err) {
      await this._sendPlain(`Error: ${(err as Error).message}`);
    }

    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this._processQueue();
  }

  // biome-ignore lint/suspicious/noExplicitAny: SDK update types are complex and dynamic
  protected _handleUpdate(update: any): void {
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

  protected _scheduleStreamFlush(): void {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this._flushStream();
    }, STREAM_BATCH_MS);
  }

  protected async _flushStream(): Promise<void> {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (!this.streamDirty || !this.streamBuffer) return;
    this.streamDirty = false;

    const text = this.streamBuffer.slice(0, this.maxLen);
    if (!this._currentChannel()) return;

    try {
      if (!this.currentMessageId) {
        const sent = await this._sendNewMessage(text);
        this.currentMessageId = sent.messageId;
      } else {
        await this._editMessage(this.currentMessageId, text);
      }
    } catch {
      // edit/send failures are non-fatal; platform impls handle markdown fallback
    }
  }

  protected async _flushOverflow(): Promise<void> {
    const text = this.streamBuffer;
    if (!this._currentChannel() || text.length <= this.maxLen) return;

    for (let i = this.maxLen; i < text.length; i += this.maxLen) {
      await this._sendOverflowChunk(text.slice(i, i + this.maxLen));
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types vary
  protected _formatPermission(params: any): string {
    const parts: string[] = [];
    const tc = params.toolCall || {};
    if (tc.title) parts.push(`Tool: ${tc.title}`);
    if (tc.name) parts.push(`Tool: ${tc.name}`);
    if (tc.status) parts.push(`Status: ${tc.status}`);
    if (tc.toolCallId && !tc.title && !tc.name) parts.push(`Call: ${tc.toolCallId}`);
    if (parts.length === 0) parts.push(JSON.stringify(params).slice(0, 500));
    return parts.join('\n');
  }
}
