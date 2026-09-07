import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client';
import type { PlatformBot } from './bot';
import type { MediaHandler } from './media';

const STREAM_BATCH_MS = 800;

export interface BaseBotOpts {
  acp: AcpClient;
  agentCmd: string;
  showThoughts: boolean;
  showTools: boolean;
  showPlan: boolean;
  streaming: boolean;
  mediaHandler: MediaHandler | null;
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt: ((text: string, chatId: number | string) => void) | null;
}

export interface QueueItem {
  channelId: string | number;
  text: string;
  blocks?: ContentBlock[];
  onComplete?: (response: string, error?: string) => void;
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
  protected showTools: boolean;
  protected showPlan: boolean;
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
  protected toolCalls: Map<string, { title?: string; status?: string; kind?: string }>;
  protected planText: string;

  protected abstract readonly maxLen: number;

  protected constructor({
    acp,
    agentCmd,
    showThoughts,
    showTools,
    showPlan,
    streaming,
    mediaHandler,
    onCommand,
    onPrompt,
  }: BaseBotOpts) {
    this.acp = acp;
    this.agentCmd = agentCmd;
    this.showThoughts = showThoughts;
    this.showTools = showTools;
    this.showPlan = showPlan;
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
    this.toolCalls = new Map();
    this.planText = '';
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

  /**
   * Handle session management commands: /new, /sessions, /session <id>, /mode, /mode <id>.
   * Returns true if the command was handled, false otherwise.
   * Uses sendMessage() so it works without an active prompt.
   */
  protected async _handleSessionCommand(
    text: string,
    channelId: string | number
  ): Promise<boolean> {
    if (!text.startsWith('/')) return false;
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(' ').trim();

    switch (cmd) {
      case 'new':
        return this._handleNewSession(channelId);
      case 'sessions':
        return this._handleListSessions(channelId);
      case 'session':
        return this._handleSwitchSession(channelId, arg);
      case 'delete':
        return this._handleDeleteSession(channelId, arg);
      case 'mode':
        return this._handleModeCommand(channelId, arg);
      default:
        return false;
    }
  }

  private async _handleNewSession(channelId: string | number): Promise<boolean> {
    if (this.busy) {
      await this.sendMessage(channelId, 'Cannot start new session while busy. Use /stop first.');
      return true;
    }
    try {
      const newId = await this.acp.newSession();
      await this.sendMessage(channelId, `🆕 New session started: \`${newId}\``);
      console.log(`🆕 new session: ${newId}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to create session: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleListSessions(channelId: string | number): Promise<boolean> {
    try {
      const sessions = await this.acp.listSessions();
      if (sessions.length === 0) {
        await this.sendMessage(channelId, 'No sessions available.');
        return true;
      }
      const lines = sessions.map((s) => {
        const title = s.title ? ` — ${s.title}` : '';
        const updated = s.updatedAt ? ` (${s.updatedAt})` : '';
        const marker = s.sessionId === this.acp.sessionId ? '▶' : ' ';
        return `${marker} \`${s.sessionId}\`${title}${updated}`;
      });
      await this.sendMessage(channelId, `*Sessions:*\n${lines.join('\n')}`);
    } catch (err) {
      await this.sendMessage(channelId, `Cannot list sessions: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleSwitchSession(channelId: string | number, arg: string): Promise<boolean> {
    if (!arg) {
      await this.sendMessage(channelId, 'Usage: /session `<id>`');
      return true;
    }
    if (this.busy) {
      await this.sendMessage(channelId, 'Cannot switch session while busy. Use /stop first.');
      return true;
    }
    try {
      const id = await this.acp.loadSession(arg);
      await this.sendMessage(channelId, `🔄 Switched to session: \`${id}\``);
      console.log(`🔄 switched to session: ${id}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to switch session: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleDeleteSession(channelId: string | number, arg: string): Promise<boolean> {
    if (!arg) {
      await this.sendMessage(channelId, 'Usage: /delete `<id>`');
      return true;
    }
    if (arg === this.acp.sessionId) {
      await this.sendMessage(channelId, 'Cannot delete the active session. Use /new first.');
      return true;
    }
    try {
      await this.acp.deleteSession(arg);
      await this.sendMessage(channelId, `🗑 Deleted session: \`${arg}\``);
      console.log(`🗑 deleted session: ${arg}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to delete session: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleModeCommand(channelId: string | number, arg: string): Promise<boolean> {
    const modes = this.acp.modes;
    if (!modes?.availableModes || modes.availableModes.length === 0) {
      await this.sendMessage(channelId, 'No session modes available.');
      return true;
    }

    if (!arg) {
      const lines = modes.availableModes.map((m) => {
        const marker = m.id === modes.currentModeId ? '▶' : ' ';
        const desc = m.description ? ` — ${m.description}` : '';
        return `${marker} \`${m.id}\` (${m.name})${desc}`;
      });
      await this.sendMessage(channelId, `*Modes:*\n${lines.join('\n')}`);
      return true;
    }

    const mode = modes.availableModes.find((m) => m.id === arg);
    if (!mode) {
      const available = modes.availableModes.map((m) => m.id).join(', ');
      await this.sendMessage(channelId, `Unknown mode \`${arg}\`. Available: ${available}`);
      return true;
    }

    try {
      await this.acp.setSessionMode(arg);
      await this.sendMessage(channelId, `🔧 Mode set to: \`${arg}\` (${mode.name})`);
      console.log(`🔧 mode set to: ${arg}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to set mode: ${(err as Error).message}`);
    }
    return true;
  }

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
    blocks?: ContentBlock[],
    onComplete?: (response: string, error?: string) => void
  ): Promise<void> {
    if (!chatId) return;
    if (await this._handleBuiltinCommand(text, chatId)) return;
    if (text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }
    this.queue.push({ channelId: chatId, text, blocks, onComplete });
    this._processQueue();
  }

  protected async _processQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

    // biome-ignore lint/style/noNonNullAssertion: queue is non-empty (checked above)
    const { channelId, text, blocks, onComplete } = this.queue.shift()!;
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessageId = null;
    this.streamDirty = false;
    this.currentChannelId = channelId;
    this.toolCalls = new Map();
    this.planText = '';

    if (this.onPrompt) this.onPrompt(text, channelId);

    let errorMsg: string | undefined;
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
      errorMsg = (err as Error).message;
      await this._sendPlain(`Error: ${errorMsg}`);
    }

    if (onComplete) {
      onComplete(this.streamBuffer, errorMsg);
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
      case 'tool_call':
        if (this.showTools) {
          const tcId = update.toolCallId || update.id || '';
          const title = update.title || update.name || '';
          const status = update.status || 'pending';
          const kind = update.kind || '';
          if (tcId) this.toolCalls.set(tcId, { title, status, kind });
          const label = title || kind || `tool:${tcId.slice(-8)}`;
          const line = `\n🔧 _${label} — ${status}_\n`;
          this.streamBuffer += line;
          this.streamDirty = true;
          if (this.streaming) this._scheduleStreamFlush();
        }
        break;
      case 'tool_call_update':
        if (this.showTools) {
          const tcId = update.toolCallId || update.id || '';
          const existing = this.toolCalls.get(tcId) || {};
          const title = update.title || existing.title || '';
          const status = update.status || existing.status || 'in_progress';
          const kind = update.kind || existing.kind || '';
          if (tcId) this.toolCalls.set(tcId, { title, status, kind });
          const label = title || kind || `tool:${tcId.slice(-8)}`;
          const line = `\n🔧 _${label} — ${status}_\n`;
          this.streamBuffer += line;
          this.streamDirty = true;
          if (this.streaming) this._scheduleStreamFlush();
        }
        break;
      case 'plan':
        if (this.showPlan) {
          const entries = update.entries || [];
          const lines = entries.map(
            // biome-ignore lint/suspicious/noExplicitAny: SDK plan entry type
            (e: any) => {
              const status = e.status || 'pending';
              const icon = status === 'completed' ? '✅' : status === 'in_progress' ? '▶' : '○';
              const content = e.content || '';
              return `${icon} ${content}`;
            }
          );
          if (lines.length > 0) {
            this.planText = `\n📋 _Plan:_\n${lines.join('\n')}\n`;
            this.streamBuffer += this.planText;
            this.streamDirty = true;
            if (this.streaming) this._scheduleStreamFlush();
          }
        }
        break;
      case 'current_mode_update':
        if (update.modeId && this.acp.modes) {
          this.acp.modes.currentModeId = update.modeId;
        }
        break;
      case 'available_commands_update':
        // Agent-advertised slash commands — stored but not yet surfaced in /help
        // Future: include in /help output
        break;
      case 'config_option_update':
        // Agent-driven config option change — stored but not yet surfaced
        // Future: update config option state for /config command
        break;
      case 'session_info_update':
        // Session metadata update (title, etc.) — informational only
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
