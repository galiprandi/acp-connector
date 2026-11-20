import { vi } from 'vitest';
import { normalizeCallback, normalizeMessage } from '../../src/transport/telegram.js';
import type { Result, TransportEventHandlers } from '../../src/transport/types.js';

/**
 * Shared PlatformTransport mock for BridgeBot tests. Records outbound
 * calls, captures inbound handlers on start(), and resolves Results
 * instead of throwing (the transport contract).
 */
export function createMockTransport() {
  const t = {
    platform: 'telegram',
    handlers: null as TransportEventHandlers | null,
    start: vi.fn(async (h: TransportEventHandlers) => {
      t.handlers = h;
    }),
    stop: vi.fn(),
    send: vi.fn(async (): Promise<Result<{ messageId: number }>> => [null, { messageId: 1 }]),
    edit: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    react: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    answerCallback: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    typing: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    fileUrl: vi.fn(async (): Promise<Result<string>> => [null, 'https://files/test']),
    sendFile: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    registerCommands: vi.fn(async (): Promise<Result<void>> => [null, undefined]),
    health: vi.fn(() => ({ ok: true })),
  };
  return t;
}

export type MockTransport = ReturnType<typeof createMockTransport>;

/** Feed a raw Bot API message through the real normalizer → onMessage. */
export function tgMessage(t: MockTransport, raw: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: partial Bot API payloads in tests
  return t.handlers?.onMessage(normalizeMessage(raw as any));
}

/** Feed a raw Bot API callback query through the real normalizer → onCallback. */
export function tgCallback(t: MockTransport, raw: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: partial Bot API payloads in tests
  return t.handlers?.onCallback?.(normalizeCallback(raw as any));
}
