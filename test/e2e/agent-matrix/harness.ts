import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../../../src/acp-client.js';
import { AliasDirectory } from '../../../src/aliases.js';
import { BaseBot } from '../../../src/base-bot.js';
import { JobManager } from '../../../src/jobs.js';
import { StateStore } from '../../../src/state.js';

export const CHAT_ID = 424242;

interface SentMessage {
  kind: 'send' | 'new' | 'edit' | 'plain' | 'overflow' | 'file';
  chatId?: string | number;
  text?: string;
  messageId?: number | string;
}

/**
 * Platform-free BaseBot for the agent matrix: captures every outbound
 * message instead of talking to Telegram/Discord, wires the real
 * JobManager + AliasDirectory + StateStore, and exposes `cmd()`/`prompt()`
 * helpers that drive the same code path a chat message takes.
 */
export class MatrixBot extends BaseBot {
  readonly sent: SentMessage[] = [];
  private nextMessageId = 1;
  readonly stateDir: string;
  readonly store: StateStore;
  readonly jobs: JobManager;
  readonly aliases: AliasDirectory;

  constructor(acp: AcpClient, agentCmd: string) {
    const stateDir = mkdtempSync(join(tmpdir(), 'acp-matrix-'));
    const store = StateStore.load(join(stateDir, 'state.json'));
    const aliases = new AliasDirectory(store);
    super({
      acp,
      agentCmd,
      showThoughts: false,
      showTools: false,
      showPlan: false,
      streaming: false,
      echoInjectedPrompts: false,
      mediaHandler: null,
      onCommand: null,
      onPrompt: null,
      platformName: 'matrix',
      aliases,
      timezone: 'UTC',
    });
    this.stateDir = stateDir;
    this.store = store;
    this.aliases = aliases;
    this.jobs = new JobManager({
      store,
      allowedChatIds: [CHAT_ID],
      timezone: 'UTC',
      enqueue: (text, chatId, source) => {
        void this.enqueuePrompt(text, chatId, undefined, undefined, source);
      },
      sendMessage: (chatId, text) => this.sendMessage(chatId, text),
      canDeliver: () => acp.sessionId !== null,
    });
    this.onCommand = (text, chatId) => this.jobs.handleCommand(text, chatId);
    // Same wiring bridge.ts does: /status picks up the live job summary.
    this.jobsSummary = () => this.jobs.summary();
  }

  /** All captured text for a chat, concatenated — for assertions. */
  transcript(chatId: string | number = CHAT_ID): string {
    return this.sent
      .filter((m) => m.chatId === undefined || m.chatId === chatId)
      .map((m) => m.text ?? '')
      .join('\n');
  }

  /** Messages captured since the last call. */
  drain(): SentMessage[] {
    return this.sent.splice(0);
  }

  /**
   * Drive a bridge command exactly like an operator message: goes through
   * enqueuePrompt's command dispatch (builtin → onCommand). Commands are
   * handled synchronously inside the call, so awaiting it means the
   * response messages are already captured.
   */
  async cmd(text: string): Promise<SentMessage[]> {
    this.drain();
    await this.enqueuePrompt(text, CHAT_ID);
    // Commands resolve inside enqueuePrompt; give microtasks a tick anyway.
    await new Promise((r) => setTimeout(r, 10));
    return this.drain();
  }

  /** Send a plain prompt and resolve with the agent's final response. */
  prompt(text: string, timeoutMs = 90_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`prompt timeout: ${text}`)), timeoutMs);
      void this.enqueuePrompt(text, CHAT_ID, undefined, (response, error) => {
        clearTimeout(timer);
        if (error) reject(new Error(error));
        else resolve(response);
      });
    });
  }

  async start(): Promise<void> {
    // nothing platform-side to start
  }

  stop(): void {
    this.jobs.stop();
  }

  async notifyAgentExit(_code: number | null): Promise<void> {
    // no-op
  }

  protected get maxLen(): number {
    return 4096;
  }

  protected async _handleBuiltinCommand(text: string, chatId: string | number): Promise<boolean> {
    if (await this._handleSessionCommand(text, chatId)) return true;
    if (text === '/stop') {
      if (!this.busy) {
        await this.sendMessage(chatId, 'Nothing to stop.');
        return true;
      }
      try {
        await this.acp.cancel();
        this.queue = [];
        await this.sendMessage(chatId, '⏹ Stopped.');
      } catch (err) {
        await this.sendMessage(chatId, `Stop failed: ${(err as Error).message}`);
      }
      return true;
    }
    if (text === '/start' || text === '/help') {
      const agentLines = this._agentCommandsHelpLines();
      const agentSection = agentLines.length > 0 ? ['', '*Agent commands:*', ...agentLines] : [];
      await this.sendMessage(
        chatId,
        [
          '👋 *acp-connector*',
          '',
          "Send any message and I'll forward it to your coding agent.",
          '',
          '*Commands:*',
          ...this._bridgeCommandHelpLines(),
          ...agentSection,
          '',
          'Any other text is sent to the agent.',
        ].join('\n')
      );
      return true;
    }
    return false;
  }

  protected async _sendPlatformMessage(
    chatId: string | number,
    text: string,
    _replyToId?: string | number
  ): Promise<{ messageId: number | string } | undefined> {
    const messageId = this.nextMessageId++;
    this.sent.push({ kind: 'send', chatId, text, messageId });
    return { messageId };
  }

  protected async _sendNewMessage(text: string): Promise<{ messageId: number | string }> {
    const messageId = this.nextMessageId++;
    this.sent.push({ kind: 'new', text, messageId });
    return { messageId };
  }

  protected async _editMessage(messageId: number | string, text: string): Promise<void> {
    this.sent.push({ kind: 'edit', text, messageId });
  }

  protected async _sendOverflowChunk(chunk: string): Promise<void> {
    this.sent.push({ kind: 'overflow', text: chunk });
  }

  protected async _sendPlain(text: string, chatId?: string | number): Promise<void> {
    this.sent.push({ kind: 'plain', chatId, text });
  }

  protected async _sendPlatformFile(
    chatId: string | number,
    filePath: string,
    caption?: string
  ): Promise<void> {
    this.sent.push({ kind: 'file', chatId, text: `${filePath} ${caption ?? ''}`.trim() });
  }

  protected async _addQueuedReaction(): Promise<void> {}
  protected async _clearQueuedReaction(): Promise<void> {}
  protected _currentChannel(): string | number | null {
    return this.currentChannelId ?? null;
  }
}

export interface AgentRuntime {
  acp: AcpClient;
  bot: MatrixBot;
  sessionId: string;
  /** True when a trivial prompt round-trips (false = agent has no LLM creds). */
  promptCapable: boolean;
  configOptionIds: string[];
  modeOptionKind: 'config' | 'synthetic' | 'none';
}

/** Boot an agent + bot; resolves null when the agent can't start at all. */
export async function bootAgent(agentCmd: string, cwd: string): Promise<AgentRuntime | null> {
  const acp = new AcpClient({ agentCmd, agentCwd: cwd });
  const sessionIds: string[] = [];
  acp.onSessionIdChange = (id) => sessionIds.push(id);
  try {
    await acp.start();
  } catch {
    acp.kill();
    return null;
  }
  const bot = new MatrixBot(acp, agentCmd);
  bot.jobs.start();

  let promptCapable = true;
  try {
    // Generous timeout: free-tier routes (e.g. dsh→OpenRouter) can be slow.
    const res = await bot.prompt('Reply with exactly: MATRIX_OK', 180_000);
    promptCapable = res.includes('MATRIX_OK');
  } catch {
    promptCapable = false;
    // A timed-out probe can leave the agent turn running — cancel it so
    // later checks don't observe a stale `busy` state.
    await acp.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }

  const configOptionIds = (acp.configOptions ?? []).map((o) => o.id);
  const hasRealMode = configOptionIds.includes('mode');
  const hasModes = (acp.modes?.availableModes?.length ?? 0) > 0;
  const modeOptionKind = hasRealMode ? 'config' : hasModes ? 'synthetic' : 'none';

  return {
    acp,
    bot,
    sessionId: acp.sessionId ?? '',
    promptCapable,
    configOptionIds,
    modeOptionKind,
  };
}

export function shutdownAgent(rt: AgentRuntime): void {
  rt.bot.stop();
  rt.acp.kill();
}
