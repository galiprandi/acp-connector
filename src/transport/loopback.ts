import type {
  ChatId,
  PlatformTransport,
  Result,
  SendOpts,
  SendResult,
  TransportEventHandlers,
  TransportHealth,
} from './types.js';

/**
 * Reference/headless transport: never touches the network, always
 * succeeds. Useful for tests that exercise transports generically and
 * as the minimal implementation example for future connectors.
 */
export class LoopbackTransport implements PlatformTransport {
  readonly platform = 'loopback';
  readonly sent: Array<{ chatId: ChatId; text: string; opts?: SendOpts }> = [];
  private handlers: TransportEventHandlers | null = null;
  private msgId = 0;

  async start(handlers: TransportEventHandlers): Promise<void> {
    this.handlers = handlers;
  }

  stop(): void {
    this.handlers = null;
  }

  /** Test hook: feed an inbound message through the registered handler. */
  async inject(text: string, chatId: ChatId = 1): Promise<void> {
    await this.handlers?.onMessage({
      chatId,
      chatType: 'private',
      messageId: ++this.msgId,
      text,
    });
  }

  async send(chatId: ChatId, text: string, opts?: SendOpts): Promise<Result<SendResult>> {
    this.sent.push({ chatId, text, opts });
    return [null, { messageId: ++this.msgId }];
  }

  async edit(): Promise<Result<void>> {
    return [null, undefined];
  }

  async react(): Promise<Result<void>> {
    return [null, undefined];
  }

  async answerCallback(): Promise<Result<void>> {
    return [null, undefined];
  }

  async typing(): Promise<Result<void>> {
    return [null, undefined];
  }

  async sendFile(): Promise<Result<void>> {
    return [null, undefined];
  }

  async registerCommands(): Promise<Result<void>> {
    return [null, undefined];
  }

  health(): TransportHealth {
    return { ok: true };
  }
}
