import type {
  ContentBlock,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionInfo,
} from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client.js';
import type { AliasDirectory } from './aliases.js';
import type { PlatformBot, PromptSource } from './bot.js';
import { identityPrefix, type SenderInfo } from './identity.js';
import { systemTimezone } from './jobs.js';
import { log } from './logger.js';
import type { MediaHandler } from './media.js';

const STREAM_BATCH_MS = 800;
const MAX_QUEUE = 100;

export interface BaseBotOpts {
  acp: AcpClient;
  agentCmd: string;
  showThoughts: boolean;
  showTools: boolean;
  showPlan: boolean;
  streaming: boolean;
  echoInjectedPrompts: boolean;
  mediaHandler: MediaHandler | null;
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  onPrompt: ((text: string, chatId: number | string) => void) | null;
  /**
   * Allow `/commands` (e.g. /a2a, /sessions, /jobs) to be run by prompts with
   * source 'http' (POST /prompt). Default false: prompt text sent over
   * HTTP is agent input, never bridge administration.
   */
  httpCommandsAllowed?: boolean;
  /** Max chars for 👤/🤖 log previews (default 150). */
  logPreviewLength?: number;
  /** Platform label used in identity prefixes and chat aliases ('telegram', 'discord'). */
  platformName?: string;
  /** Chat alias directory — fed on every inbound user message. */
  aliases?: AliasDirectory | null;
  /** `config.timezone` — used by /time and job schedule rendering. */
  timezone?: string;
}

export interface QueueItem {
  channelId: string | number;
  text: string;
  blocks?: ContentBlock[];
  onComplete?: (response: string, error?: string) => void;
  /** Optional streaming hook — called per text chunk (used by A2A SSE). */
  onChunk?: (chunk: string) => void;
  /** Original user message id — used to react/clear a queued indicator. */
  messageId?: string | number;
  /** True if a ⏳ reaction was added to messageId while queued. */
  queuedReaction?: boolean;
  /** Sender/chat identity — prefixes the prompt so the agent knows who is talking. */
  sender?: SenderInfo;
}

export interface PermissionResponse {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

export interface PermissionPending {
  resolve: (response: PermissionResponse) => void;
  /** Id of the message carrying the permission buttons — stale buttons from
   * older prompts must not resolve the current pending request. */
  messageId?: number | string;
}

export abstract class BaseBot implements PlatformBot {
  protected acp: AcpClient;
  protected agentCmd: string;
  protected showThoughts: boolean;
  protected showTools: boolean;
  protected showPlan: boolean;
  protected streaming: boolean;
  protected echoInjectedPrompts: boolean;
  protected mediaHandler: MediaHandler | null;
  /** When true, prompts from POST /prompt (source 'http') may run bridge commands. */
  httpCommandsAllowed: boolean;
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
  protected typingTimer: NodeJS.Timeout | null;
  protected startedAt: number;
  protected previewLength: number;
  protected platformName: string;
  protected aliases: AliasDirectory | null;
  protected timezone?: string;
  /** Last chat that sent a user message — fallback target for agent file sends. */
  protected lastUserChannelId: string | number | null;
  /** Last /sessions listing — lets /session <n> resolve numbers to ids. */
  private lastSessionList: { sessions: SessionInfo[]; at: number } | null;

  protected abstract readonly maxLen: number;

  protected constructor({
    acp,
    agentCmd,
    showThoughts,
    showTools,
    showPlan,
    streaming,
    echoInjectedPrompts,
    mediaHandler,
    onCommand,
    onPrompt,
    httpCommandsAllowed = false,
    logPreviewLength,
    platformName = 'unknown',
    aliases = null,
    timezone,
  }: BaseBotOpts) {
    this.acp = acp;
    this.agentCmd = agentCmd;
    this.showThoughts = showThoughts;
    this.showTools = showTools;
    this.showPlan = showPlan;
    this.streaming = streaming;
    this.echoInjectedPrompts = echoInjectedPrompts;
    this.mediaHandler = mediaHandler;
    this.httpCommandsAllowed = httpCommandsAllowed;
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
    this.typingTimer = null;
    this.startedAt = Date.now();
    this.previewLength = Math.max(20, Math.floor(logPreviewLength ?? 150));
    this.platformName = platformName;
    this.aliases = aliases;
    this.timezone = timezone;
    this.lastUserChannelId = null;
    this.lastSessionList = null;
  }

  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract notifyAgentExit(code: number | null): Promise<void>;

  /**
   * Send a message to a chat, splitting text longer than the platform limit
   * (`maxLen`) into continuation chunks. Chunks prefer paragraph (`\n\n`),
   * then line (`\n`), then word (space) boundaries over hard cuts, and
   * continuations are threaded as replies to the first chunk when the
   * platform supports it.
   */
  async sendMessage(chatId: number | string, text: string): Promise<void> {
    const chunks = this._chunkText(text);
    let replyToId: number | string | undefined;
    for (const chunk of chunks) {
      const sent = await this._sendPlatformMessage(chatId, chunk, replyToId);
      replyToId = sent?.messageId ?? replyToId;
    }
  }

  /**
   * Split text into chunks of at most `maxLen` chars, preferring
   * paragraph/line/word boundaries over mid-word hard cuts.
   */
  protected _chunkText(text: string): string[] {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > this.maxLen) {
      const window = rest.slice(0, this.maxLen);
      let idx = window.lastIndexOf('\n\n');
      if (idx <= 0) idx = window.lastIndexOf('\n');
      if (idx <= 0) idx = window.lastIndexOf(' ');
      if (idx <= 0) idx = this.maxLen;
      chunks.push(rest.slice(0, idx));
      rest = rest.slice(idx);
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
  }

  /**
   * Platform primitive: send ONE message (already within `maxLen`).
   * `replyToId` is set for continuation chunks — platforms that support
   * replies should thread them to the first chunk's message id.
   * Returns the sent message id when available.
   */
  protected abstract _sendPlatformMessage(
    chatId: number | string,
    text: string,
    replyToId?: number | string
  ): Promise<{ messageId?: number | string } | undefined>;

  protected abstract _sendNewMessage(text: string): Promise<{ messageId: number | string }>;
  protected abstract _editMessage(messageId: number | string, text: string): Promise<void>;
  protected abstract _sendOverflowChunk(chunk: string): Promise<void>;
  protected abstract _sendPlain(text: string, chatId?: string | number): Promise<void>;
  /**
   * Platform primitive: send a local file to a chat (document or media
   * with preview depending on platform/type). Used by the acp-tools
   * `send_file` tool — path validation happens in the bridge API.
   */
  protected abstract _sendPlatformFile(
    chatId: string | number,
    filePath: string,
    caption?: string
  ): Promise<void>;

  /**
   * Send a local file to a chat — entry point for the acp-tools
   * `send_file` tool. Implemented per platform via _sendPlatformFile.
   */
  async sendFile(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this._sendPlatformFile(chatId, filePath, caption);
  }

  /** Platform label ('telegram', 'discord') — used for alias routing. */
  get platform(): string {
    return this.platformName;
  }

  /**
   * Chat the agent is currently talking to: the busy prompt's channel,
   * falling back to the last chat that sent a user message. Null when no
   * user chat is known (e.g. only cron/http traffic so far).
   */
  defaultChatTarget(): { platform: string; chatId: string | number } | null {
    const chatId = this.busy ? this.currentChannelId : this.lastUserChannelId;
    if (chatId === null || chatId === undefined) return null;
    return { platform: this.platformName, chatId };
  }

  protected abstract _addQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void>;
  protected abstract _clearQueuedReaction(
    channelId: string | number,
    messageId: string | number
  ): Promise<void>;
  protected abstract _currentChannel(): string | number | null;
  protected abstract _handleBuiltinCommand(
    text: string,
    channelId: string | number
  ): Promise<boolean>;

  /**
   * Handle bridge commands. Noun-first grammar:
   *   /sessions [new|<n>|<id>|rm <ref>]  — session lifecycle
   *   /config [<id> [n|value]]           — session settings (absorbs /mode, /model)
   *   /queue [rm <n>|clear]              — pending prompt queue
   *   /time                              — host/config/UTC clocks
   *   /status                            — agent state summary
   * Returns true if the command was handled, false otherwise.
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
      case 'sessions':
        return this._handleSessionsCommand(channelId, arg);
      case 'config':
        return this._handleConfigCommand(channelId, parts.slice(1));
      case 'queue':
        return this._handleQueueCommand(channelId, arg);
      case 'time':
        return this._handleTimeCommand(channelId);
      case 'status':
        return this._handleStatusCommand(channelId);
      default:
        return false;
    }
  }

  private async _handleSessionsCommand(channelId: string | number, arg: string): Promise<boolean> {
    if (!arg) return this._handleListSessions(channelId);
    const [sub, ...rest] = arg.split(/\s+/);
    const restStr = rest.join(' ').trim();

    if (sub === 'new') return this._handleNewSession(channelId);
    if (sub === 'rm' || sub === 'delete' || sub === 'remove') {
      return this._handleDeleteSession(channelId, restStr);
    }
    // `/sessions <n|id>` — numeric indexes the cached /sessions list,
    // anything else is a literal session id (full or unique prefix).
    return this._handleSwitchSession(channelId, arg);
  }

  private async _handleNewSession(channelId: string | number): Promise<boolean> {
    if (this.busy) {
      await this.sendMessage(channelId, 'Cannot start new session while busy. Use /stop first.');
      return true;
    }
    try {
      const newId = await this.acp.newSession();
      await this.sendMessage(channelId, `🆕 New session started: \`${newId}\``);
      log.info(`🆕 new session: ${newId}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to create session: ${(err as Error).message}`);
    }
    return true;
  }

  /** Cached /sessions list stays valid for index lookups for this long. */
  private static readonly SESSION_LIST_TTL_MS = 10 * 60 * 1000;

  private async _handleListSessions(channelId: string | number): Promise<boolean> {
    try {
      const sessions = await this.acp.listSessions();
      this.lastSessionList = { sessions, at: Date.now() };
      if (sessions.length === 0) {
        await this.sendMessage(channelId, 'No sessions available.');
        return true;
      }
      const lines = sessions.map((s, i) => {
        const title = s.title?.trim() || s.sessionId.slice(0, 12);
        const age = s.updatedAt ? ` — ${this._formatSessionAge(s.updatedAt)}` : '';
        const marker = s.sessionId === this.acp.sessionId ? '▶ ' : '  ';
        return `${marker}${i + 1}. ${title}${age}`;
      });
      await this.sendMessage(
        channelId,
        `*Sessions:*\n${lines.join('\n')}\n\nSwitch with /sessions <n> or /sessions <id>.`
      );
    } catch (err) {
      await this.sendMessage(channelId, `Cannot list sessions: ${(err as Error).message}`);
    }
    return true;
  }

  /** Compact age label for a session's updatedAt ("2h ago", "3d ago", date). */
  private _formatSessionAge(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return iso.slice(0, 10);
  }

  /**
   * Resolve a /session argument: a bare number indexes into the cached
   * /sessions listing; anything else is treated as a literal session id
   * (full or unique prefix handled by the agent).
   */
  private _resolveSessionArg(arg: string): { id: string } | { error: string } {
    if (/^\d+$/.test(arg)) {
      const cached = this.lastSessionList;
      const fresh =
        cached && Date.now() - cached.at < BaseBot.SESSION_LIST_TTL_MS ? cached.sessions : null;
      if (!fresh) {
        return { error: 'Run /sessions first to get a numbered list.' };
      }
      const idx = Number.parseInt(arg, 10) - 1;
      const hit = fresh[idx];
      if (!hit) {
        return { error: `No session #${arg} — run /sessions to see ${fresh.length} entries.` };
      }
      return { id: hit.sessionId };
    }
    return { id: arg };
  }

  private async _handleSwitchSession(channelId: string | number, arg: string): Promise<boolean> {
    if (!arg) {
      await this.sendMessage(channelId, 'Usage: /sessions `<n>` or /sessions `<id>`');
      return true;
    }
    if (this.busy) {
      await this.sendMessage(channelId, 'Cannot switch session while busy. Use /stop first.');
      return true;
    }
    const resolved = this._resolveSessionArg(arg);
    if ('error' in resolved) {
      await this.sendMessage(channelId, resolved.error);
      return true;
    }
    try {
      const id = await this.acp.loadSession(resolved.id);
      await this.sendMessage(channelId, `🔄 Switched to session: \`${id}\``);
      log.info(`🔄 switched to session: ${id}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to switch session: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleDeleteSession(channelId: string | number, arg: string): Promise<boolean> {
    if (!arg) {
      await this.sendMessage(channelId, 'Usage: /sessions rm `<id>`');
      return true;
    }
    // Numeric refs resolve against the cached /sessions list too.
    let target = arg;
    if (/^\d+$/.test(arg)) {
      const resolved = this._resolveSessionArg(arg);
      if ('error' in resolved) {
        await this.sendMessage(channelId, resolved.error);
        return true;
      }
      target = resolved.id;
    }
    if (target === this.acp.sessionId) {
      await this.sendMessage(
        channelId,
        'Cannot delete the active session. Use /sessions new first.'
      );
      return true;
    }
    try {
      await this.acp.deleteSession(target);
      await this.sendMessage(channelId, `🗑 Deleted session: \`${target}\``);
      log.info(`🗑 deleted session: ${target}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to delete session: ${(err as Error).message}`);
    }
    return true;
  }

  private async _handleQueueCommand(channelId: string | number, arg: string): Promise<boolean> {
    const sub = arg.split(/\s+/)[0]?.toLowerCase();

    if (sub === 'clear') {
      const count = this.queue.length;
      for (const item of this.queue) {
        if (item.queuedReaction && item.messageId !== undefined) {
          this._clearQueuedReaction(item.channelId, item.messageId).catch(() => {});
        }
      }
      this.queue = [];
      await this.sendMessage(
        channelId,
        count === 0 ? 'Queue is already empty.' : `🗑 Cleared ${count} queued prompt(s).`
      );
      return true;
    }

    if (sub === 'rm' || sub === 'cancel') {
      const idx = parseInt(arg.split(/\s+/)[1] ?? '', 10);
      if (Number.isNaN(idx) || idx < 1 || idx > this.queue.length) {
        await this.sendMessage(channelId, 'Usage: /queue rm `<position>`');
        return true;
      }
      const [removed] = this.queue.splice(idx - 1, 1);
      if (removed.queuedReaction && removed.messageId !== undefined) {
        this._clearQueuedReaction(removed.channelId, removed.messageId).catch(() => {});
      }
      const preview = removed.text.slice(0, 60).replace(/\n/g, ' ');
      await this.sendMessage(
        channelId,
        `🗑 Cancelled queued prompt ${idx}: ${preview}${removed.text.length > 60 ? '…' : ''}`
      );
      return true;
    }

    if (this.queue.length === 0) {
      await this.sendMessage(channelId, 'Queue is empty.');
      return true;
    }
    const lines = this.queue.map((item, i) => {
      const preview = item.text.slice(0, 60).replace(/\n/g, ' ');
      return `${i + 1}. ${preview}${item.text.length > 60 ? '…' : ''}`;
    });
    await this.sendMessage(channelId, `*Queued prompts:*\n${lines.join('\n')}`);
    return true;
  }

  /**
   * /time — the three clocks that matter for scheduling: the bridge
   * host's system zone, the operator's configured timezone, and UTC.
   * The agent has no clock of its own — this is the authoritative
   * reference the operator (and the agent, via job confirmations)
   * can check against.
   */
  private async _handleTimeCommand(channelId: string | number): Promise<boolean> {
    const now = new Date();
    const fmt = (tz: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'shortOffset',
      }).format(now);
    const hostTz = systemTimezone();
    const lines = [
      `🕐 Host:   ${fmt(hostTz)} — ${hostTz}`,
      this.timezone
        ? `⚙️ Config: ${fmt(this.timezone)} — ${this.timezone}`
        : '⚙️ Config: (no timezone set — naive times are rejected)',
      `🌐 UTC:    ${fmt('UTC')}`,
    ];
    await this.sendMessage(channelId, lines.join('\n'));
    return true;
  }

  private async _handleStatusCommand(channelId: string | number): Promise<boolean> {
    const uptimeMs = Date.now() - this.startedAt;
    const mins = Math.floor(uptimeMs / 60000);
    const hours = Math.floor(mins / 60);
    const uptime = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;
    const state = this.busy ? 'busy' : 'idle';
    const mode = this.acp.modes?.currentModeId || 'default';
    const lines = [
      `🟢 agent: ${state}`,
      `📋 queue: ${this.queue.length} pending`,
      `🆔 session: \`${this.acp.sessionId || 'none'}\``,
      `⚙️ mode: \`${mode}\``,
      `🖥️ agent: \`${this.agentCmd}\``,
      `⏱ uptime: ${uptime}`,
    ];
    await this.sendMessage(channelId, lines.join('\n'));
    return true;
  }

  /**
   * Session modes surfaced as a synthetic config option so /config is the
   * single settings surface — agents that expose `mode` via
   * session/set_mode (not configOptions) still get a numbered picker.
   * Returns null when modes exist but a real `mode` configOption already
   * covers them (the real option wins).
   */
  private _modeAsConfigOption(): SessionConfigOption | null {
    const modes = this.acp.modes;
    if (!modes?.availableModes || modes.availableModes.length === 0) return null;
    if (this.acp.configOptions?.some((o) => o.id === 'mode')) return null;
    return {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    } as SessionConfigOption;
  }

  /**
   * Handle the /config command: generic session config options per ACP
   * `session/set_config_option`. `/config mode` falls back to session
   * modes (set_mode) when the agent doesn't expose mode as a config
   * option — /model is just /config model.
   *   /config                — list all options with current values
   *   /config <id>           — list the option's selectable values
   *   /config <id> <value>   — set the option value (number picks from list)
   */
  private async _handleConfigCommand(channelId: string | number, args: string[]): Promise<boolean> {
    const realOptions = this.acp.configOptions ?? [];
    const syntheticMode = this._modeAsConfigOption();
    const options = [...realOptions, ...(syntheticMode ? [syntheticMode] : [])];
    if (options.length === 0) {
      await this.sendMessage(channelId, 'No config options reported by the agent.');
      return true;
    }

    const [configId, ...rest] = args;
    let value = rest.join(' ').trim();

    if (!configId) {
      const lines = options.map(
        (o) => `  \`${o.id}\` (${o.name}) — ${this._configCurrentValue(o)}`
      );
      await this.sendMessage(channelId, `*Config options:*\n${lines.join('\n')}`);
      return true;
    }

    const option = options.find((o) => o.id === configId);
    if (!option) {
      const available = options.map((o) => o.id).join(', ');
      await this.sendMessage(channelId, `Unknown option \`${configId}\`. Available: ${available}`);
      return true;
    }

    if (!value) {
      await this.sendMessage(channelId, this._formatConfigOptionDetail(option));
      return true;
    }

    if (option.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        await this.sendMessage(channelId, `Option \`${configId}\` is boolean. Use: true or false`);
        return true;
      }
    } else {
      // Bare numbers index into the displayed option list — same flattened
      // order as _formatConfigOptionDetail, so "pick 2" always matches.
      const selectOpts = this._configSelectOptions(option);
      if (/^\d+$/.test(value)) {
        const idx = Number.parseInt(value, 10) - 1;
        const hit = selectOpts[idx];
        if (!hit) {
          await this.sendMessage(
            channelId,
            `No option #${value} — run /config ${configId} to see ${selectOpts.length} entries.`
          );
          return true;
        }
        value = hit.value;
      }
      const match = selectOpts.find((o) => o.value === value);
      if (!match) {
        const available = selectOpts.map((o) => o.value).join(', ');
        await this.sendMessage(channelId, `Unknown value \`${value}\`. Available: ${available}`);
        return true;
      }
    }

    try {
      // Synthetic `mode` option routes to session/set_mode; real config
      // options go through session/set_config_option.
      if (option === syntheticMode) {
        await this.acp.setSessionMode(value);
      } else {
        await this.acp.setConfigOption(configId, value);
      }
      await this.sendMessage(channelId, `⚙️ \`${configId}\` set to: \`${value}\``);
      log.info(`⚙️ config ${configId} set to: ${value}`);
    } catch (err) {
      await this.sendMessage(channelId, `Failed to set option: ${(err as Error).message}`);
    }
    return true;
  }

  private _configSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
    if (option.type === 'boolean') return [];
    const raw = option.options || [];
    // Options may be a flat list or grouped ({group, name, options[]})
    if (raw.length > 0 && 'options' in raw[0]) {
      return (raw as SessionConfigSelectGroup[]).flatMap((g) => g.options);
    }
    return raw as SessionConfigSelectOption[];
  }

  private _configCurrentValue(option: SessionConfigOption): string {
    if (option.type === 'boolean') return String(option.currentValue);
    const match = this._configSelectOptions(option).find((o) => o.value === option.currentValue);
    return match ? `\`${match.value}\` (${match.name})` : `\`${option.currentValue}\``;
  }

  private _formatConfigOptionDetail(option: SessionConfigOption): string {
    const header = `*\`${option.id}\`* (${option.name})${option.description ? ` — ${option.description}` : ''}`;
    if (option.type === 'boolean') {
      return `${header}\nCurrent: \`${option.currentValue}\`. Use: /config ${option.id} true|false`;
    }
    const lines = this._configSelectOptions(option).map((o, i) => {
      const marker = o.value === option.currentValue ? '▶ ' : '  ';
      const desc = o.description ? ` — ${o.description}` : '';
      return `${marker}${i + 1}. ${o.name}${desc}`;
    });
    return `${header}\n${lines.join('\n')}\n\nSet with /config ${option.id} <n> or <value>.`;
  }

  /**
   * Static bridge-command lines shared by the /help output of every
   * platform. Agent-advertised commands are appended separately.
   */
  protected _bridgeCommandHelpLines(): string[] {
    return [
      '  /stop — cancel the current task',
      '  /sessions — list sessions (numbered)',
      '  /sessions new — start a fresh session',
      '  /sessions `<n|id>` — switch session · /sessions rm `<id>` — delete',
      '  /config — list session options (model, mode, …)',
      '  /config `<id> [n|value]` — show or set an option',
      '  /queue — list pending prompts · /queue rm `<n>` · /queue clear',
      '  /jobs — list scheduled/manual jobs',
      '  /jobs add `[as <name>] <when> <prompt>` — `in 20m` · `every 1h` · date · cron · `manual`',
      '  /jobs run|toggle|rm `<n|name>` — manage a job',
      '  /time — host/config/UTC clocks',
      '  /status — agent state, session, queue and uptime',
    ];
  }

  /**
   * Help lines for slash commands advertised by the agent via
   * `available_commands_update`. Empty when the agent reports none (e.g. pi).
   */
  protected _agentCommandsHelpLines(): string[] {
    const commands = this.acp.availableCommands;
    if (!commands || commands.length === 0) return [];
    return commands.map((c) => {
      const hint = c.input?.hint ? ` ${c.input.hint}` : '';
      const desc = c.description ? ` — ${c.description}` : '';
      return `  /${c.name}${hint}${desc}`;
    });
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
    onComplete?: (response: string, error?: string) => void,
    source?: PromptSource,
    onChunk?: (chunk: string) => void
  ): Promise<void> {
    if (!chatId) return;
    // Commands are processed for user messages and first-class operator
    // entry points (jobs, http when opted in) — agent-job prompts, a2a
    // prompts and non-opted http prompts are remote content: agent input,
    // not bridge administration.
    const isRemoteContent =
      source === 'a2a' ||
      (source === 'http' && !this.httpCommandsAllowed) ||
      source === 'agent-job';
    if (!isRemoteContent && (await this._handleBuiltinCommand(text, chatId))) return;
    if (!isRemoteContent && text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, chatId);
      if (handled) return;
    }
    if (this.echoInjectedPrompts && source) {
      const icon =
        source === 'job' || source === 'agent-job' ? '⏰' : source === 'http' ? '🌐' : '🔁';
      const label = `[${source}]`;
      const preview = text.slice(0, 200).replace(/\n/g, ' ');
      const suffix = text.length > 200 ? '…' : '';
      await this._sendPlain(`${icon} ${label} ${preview}${suffix}`, chatId);
    }
    if (this.queue.length >= MAX_QUEUE) {
      log.warn(`prompt queue full (${MAX_QUEUE}), dropping ${source ?? 'user'} prompt`);
      onComplete?.('', 'queue full');
      void this.sendMessage(chatId, '⚠️ Queue is full — try again later.').catch(() => {});
      return;
    }
    this.queue.push({ channelId: chatId, text, blocks, onComplete, onChunk });
    this._processQueue();
  }

  /**
   * Enqueue a user-sent message. If the bot is busy, reacts to the user's
   * message with ⏳ to signal it's queued; the reaction is cleared when the
   * item starts processing.
   */
  protected _enqueueUserMessage(
    channelId: string | number,
    messageId: string | number,
    text: string,
    blocks?: ContentBlock[],
    sender?: SenderInfo
  ): void {
    if (sender) {
      this.lastUserChannelId = channelId;
      this.aliases?.register(this.platformName, channelId, sender);
    }
    const item: QueueItem = { channelId, text, blocks, messageId, sender };
    if (this.queue.length >= MAX_QUEUE) {
      log.warn(`prompt queue full (${MAX_QUEUE}), dropping user message`);
      void this.sendMessage(channelId, '⚠️ Queue is full — try again later.').catch(() => {});
      return;
    }
    if (this.busy) {
      item.queuedReaction = true;
      this._addQueuedReaction(channelId, messageId).catch(() => {
        item.queuedReaction = false;
      });
    }
    this.queue.push(item);
    this._processQueue();
  }

  protected async _processQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

    // biome-ignore lint/style/noNonNullAssertion: queue is non-empty (checked above)
    const item = this.queue.shift()!;
    const { channelId, text, blocks, onComplete } = item;

    if (item.queuedReaction && item.messageId !== undefined) {
      this._clearQueuedReaction(channelId, item.messageId).catch(() => {});
    }
    this.busy = true;
    this.streamBuffer = '';
    this.currentMessageId = null;
    this.streamDirty = false;
    this.currentChannelId = channelId;
    this.toolCalls = new Map();
    this._startTypingLoop();
    this.planText = '';

    if (this.onPrompt) this.onPrompt(text, channelId);

    // User messages carry sender identity: prepend `[Platform/Chat] Name:`
    // so the agent knows who is talking and which alias to reply to.
    // Injected sources (cron/http/a2a/reminders) have no sender — their
    // prompts already carry a `[source]` label.
    const promptPayload = item.sender
      ? blocks
        ? [
            { type: 'text' as const, text: identityPrefix(this.platformName, item.sender) },
            ...blocks,
          ]
        : `${identityPrefix(this.platformName, item.sender)}${text}`
      : blocks || text;

    let errorMsg: string | undefined;
    try {
      await this.acp.prompt(promptPayload);

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
      const respPreview = this.streamBuffer.slice(0, this.previewLength).replace(/\n/g, ' ');
      log.info(`🤖 ${respPreview}${respLen > this.previewLength ? '…' : ''}`);

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

    this._stopTypingLoop();
    this.busy = false;
    this.currentMessageId = null;
    this.streamBuffer = '';
    this._processQueue();
  }

  /**
   * Typing indicator loop. Telegram's sendChatAction expires after ~5s and
   * Discord's sendTyping after ~10s — re-send every 4s while busy.
   */
  protected _startTypingLoop(): void {
    this._sendTypingIndicator();
    this.typingTimer = setInterval(() => {
      this._sendTypingIndicator();
    }, 4000);
    this.typingTimer.unref?.();
  }

  protected _stopTypingLoop(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  /** Platform-specific typing action. No-op default for platforms without it. */
  protected _sendTypingIndicator(): void {}

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
        if (update.availableCommands) {
          this.acp.availableCommands = update.availableCommands;
        }
        break;
      case 'config_option_update':
        if (update.configOptions) {
          this.acp.configOptions = update.configOptions;
        }
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
