import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client.js';
import type { PlatformBot } from './bot.js';
import { log } from './logger.js';
import type { MediaHandler } from './media.js';

interface QueueItem {
  text: string;
  blocks?: ContentBlock[];
  onComplete?: (response: string, error?: string) => void;
}

/**
 * Headless PlatformBot: processes the prompt queue against the ACP
 * session without any messaging platform. This is what makes the bridge
 * runnable in containers, tests, or any deployment without Telegram or
 * Discord — prompts come from HTTP /prompt or A2A tasks, responses are
 * delivered through the onComplete callback instead of a chat.
 */
export class LoopbackBot implements PlatformBot {
  private queue: QueueItem[] = [];
  private busy = false;
  private onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null = null;

  constructor(private acp: AcpClient) {}

  async start(): Promise<void> {
    log.info('🔁 Loopback bot ready (no messaging platform)');
  }

  stop(): void {
    this.queue = [];
  }

  async enqueuePrompt(
    text: string,
    _chatId?: number | string,
    blocks?: ContentBlock[],
    onComplete?: (response: string, error?: string) => void,
    source?: 'cron' | 'http' | 'routine' | 'a2a'
  ): Promise<void> {
    if (source !== 'a2a' && text.startsWith('/') && this.onCommand) {
      const handled = await this.onCommand(text, 'loopback');
      if (handled) return;
    }
    this.queue.push({ text, blocks, onComplete });
    void this._process();
  }

  async sendMessage(_chatId: number | string, text: string): Promise<void> {
    log.info(`[loopback→owner] ${text}`);
  }

  async notifyAgentExit(code: number | null): Promise<void> {
    log.warn(`[loopback] agent exited (code=${code})`);
  }

  hasActivePrompt(): boolean {
    return this.busy;
  }

  /**
   * Permission routing compatibility: headless mode has no human to ask,
   * so the first 'allow*' option is auto-selected (mirrors the fallback in
   * AcpClient._handlePermission).
   */
  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types are complex
  _handlePermission(params: any): unknown {
    const allowOpt = params.options?.find((o: { kind: string }) => o.kind.startsWith('allow'));
    if (allowOpt) return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
    return { outcome: { outcome: 'cancelled' } };
  }

  setMediaHandler(_handler: MediaHandler): void {}
  setCommandHandler(
    fn: ((text: string, chatId: number | string) => Promise<boolean>) | null
  ): void {
    this.onCommand = fn;
  }

  private async _process(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    const item = this.queue.shift() as QueueItem;
    this.busy = true;

    let buffer = '';
    let errorMsg: string | undefined;
    try {
      await this.acp.prompt(item.blocks ?? item.text);
      for (;;) {
        // biome-ignore lint/suspicious/noExplicitAny: SDK update types are dynamic
        const message: any = await this.acp.nextUpdate();
        if (message.kind === 'stop') break;
        const update = message.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          buffer += update.content.text;
        } else if (update?.sessionUpdate === 'agent_message') {
          const content = Array.isArray(update.content) ? update.content : [update.content];
          buffer = content
            .filter((c: { type?: string }) => c?.type === 'text')
            .map((c: { text?: string }) => c.text ?? '')
            .join('');
        }
      }
    } catch (err) {
      errorMsg = (err as Error).message;
      log.error(`[loopback] prompt failed: ${errorMsg}`);
    }

    item.onComplete?.(buffer, errorMsg);
    this.busy = false;
    void this._process();
  }
}
