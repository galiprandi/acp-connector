import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClient } from '../src/acp-client';
import { normalizeCallback, normalizeMessage } from '../src/transport/telegram';
import type { Result, TransportEventHandlers } from '../src/transport/types';

type MockFn = ReturnType<typeof vi.fn>;

// PlatformTransport mock — records calls, captures inbound handlers, and
// resolves Results instead of throwing (the transport contract).
const mockT = {
  platform: 'telegram',
  handlers: null as TransportEventHandlers | null,
  start: vi.fn(async (h: TransportEventHandlers) => {
    mockT.handlers = h;
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

// Feed raw Bot API payloads through the real transport normalizers so
// tests exercise the same InboundMessage shape production produces.
// biome-ignore lint/suspicious/noExplicitAny: test payloads are partial Bot API objects
const onMessage = (raw: any) => mockT.handlers?.onMessage(normalizeMessage(raw));
// biome-ignore lint/suspicious/noExplicitAny: test payloads are partial Bot API objects
const onCallback = (raw: any) => mockT.handlers?.onCallback?.(normalizeCallback(raw));

interface MockAcpUpdate {
  kind: string;
  update?: Record<string, unknown>;
  stopReason?: string;
}

interface MockAcp {
  prompt: MockFn;
  nextUpdate: MockFn;
  cancel: MockFn;
  newSession: MockFn;
  listSessions: MockFn;
  loadSession: MockFn;
  setSessionMode: MockFn;
  deleteSession: MockFn;
  closeSession: MockFn;
  setConfigOption: MockFn;
  restart: MockFn;
  sessionId: string | null;
  modes: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  } | null;
  configOptions: Array<{
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: unknown;
    options?: unknown[];
  }> | null;
  availableCommands: Array<{
    name: string;
    description?: string;
    input?: { hint?: string };
  }> | null;
  _pushUpdate: (update: MockAcpUpdate) => void;
  _updates: MockAcpUpdate[];
}

// Mock ACP client
function createMockAcp(): MockAcp {
  const updates: MockAcpUpdate[] = [];
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift() as MockAcpUpdate;
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'new-session-id'),
    listSessions: vi.fn(async () => [
      { sessionId: 's1', cwd: '/tmp', title: 'Session 1', updatedAt: null },
      { sessionId: 's2', cwd: '/tmp', title: null, updatedAt: null },
    ]),
    loadSession: vi.fn(async (id: string) => id),
    setSessionMode: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    sessionId: 'test-session-id',
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'bypass', name: 'Bypass', description: 'Auto-approve all tool calls' },
      ],
    },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'model-a',
        options: [
          { value: 'model-a', name: 'Model A' },
          { value: 'model-b', name: 'Model B', description: 'Fast' },
        ],
      },
      {
        id: 'verbose',
        name: 'Verbose',
        type: 'boolean',
        currentValue: false,
      },
    ],
    availableCommands: [
      { name: 'compact', description: 'Force conversation compaction' },
      { name: 'rename', description: 'Rename this session', input: { hint: '<new title>' } },
    ],
    _pushUpdate: (update: MockAcpUpdate): number => updates.push(update),
    _updates: updates,
  };
}

const { BridgeBot } = await import('../src/bot.js');

type BotOverrides = Partial<ConstructorParameters<typeof BridgeBot>[0]>;

function createBot(overrides: BotOverrides = {}) {
  const acp = createMockAcp();
  const bot = new BridgeBot({
    acp: acp as unknown as AcpClient,
    transport: mockT,
    allowedChatIds: [123],
    agentCmd: 'acp-agent serve',
    ...overrides,
  });
  return { bot, acp };
}

describe('BridgeBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and sets up handlers', async () => {
    const { bot } = createBot();
    await bot.start();
    expect(mockT.start).toHaveBeenCalled();
    expect(mockT.handlers?.onMessage).toBeTypeOf('function');
    expect(mockT.handlers?.onCallback).toBeTypeOf('function');
  });

  it('rejects unauthorized chat ID', async () => {
    const { bot } = createBot({ allowedChatIds: [123] });
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 999 }, text: 'hello' });
    expect(mockT.send).not.toHaveBeenCalledWith(999, expect.anything());
  });

  it('responds with chat ID in setup mode (empty allowlist)', async () => {
    const { bot } = createBot({ allowedChatIds: [] });
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 999 }, text: 'hello' });
    expect(mockT.send).toHaveBeenCalledWith(999, expect.stringContaining('Your chat ID is: 999'));
  });

  it('rejects non-text messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, photo: [{ file_id: 'x' }] });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Media no soportado');
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('queues and forwards text to ACP', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hello agent' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('hello agent');
  });

  it('prefixes DM prompts with [Telegram] SenderName:', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: 123, type: 'private' },
      from: { id: 42, first_name: 'Germán', last_name: 'Aliprandi' },
      text: 'hello agent',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('[Telegram] Germán Aliprandi: hello agent');
  });

  it('prefixes group prompts with [Telegram/Chat] Sender: keeping sender vs destination', async () => {
    const { bot, acp } = createBot({ allowedChatIds: [-100] });
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: -100, type: 'supergroup', title: 'Familia' },
      from: { id: 7, first_name: 'Santi' },
      text: 'pasame el resumen',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('[Telegram/Familia] Santi: pasame el resumen');
  });

  it('registers chat aliases from inbound messages', async () => {
    const { AliasDirectory } = await import('../src/aliases.js');
    const aliases = new AliasDirectory();
    const { bot } = createBot({ aliases, allowedChatIds: [-100, 123] });
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: -100, type: 'supergroup', title: 'Familia' },
      from: { id: 7, first_name: 'Santi' },
      text: 'hi',
    });
    await vi.advanceTimersByTimeAsync(1000);
    const group = aliases.resolve('Telegram/Familia');
    expect(group.ok && group.entry.chatId).toBe('-100');
    // sender name must not alias the group chat
    expect(aliases.resolve('Telegram/Santi').ok).toBe(false);
  });

  it('sendFile delivers documents and photos to the given chat', async () => {
    const { bot } = createBot();
    await bot.sendFile(123, '/tmp/report.pdf', 'quarterly');
    expect(mockT.sendFile).toHaveBeenCalledWith(
      123,
      '/tmp/report.pdf',
      expect.objectContaining({ caption: 'quarterly', isImage: false })
    );
    await bot.sendFile(123, '/tmp/pic.png');
    expect(mockT.sendFile).toHaveBeenCalledWith(
      123,
      '/tmp/pic.png',
      expect.objectContaining({ isImage: true })
    );
  });

  it('streams agent_message_chunk and edits single message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, 'Hello', { parseMode: 'Markdown' });
  });

  it('handles agent_message (full message)', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'agent_message',
        content: [{ type: 'text', text: 'Full response' }],
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, 'Full response', {
      parseMode: 'Markdown',
    });
  });

  it('splits output >4096 chars into multiple messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const longText: string = 'A'.repeat(5000);
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message', content: { type: 'text', text: longText } },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(2000);
    // First message (send) + overflow chunks (send)
    const sends = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to plain text on markdown parse error', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    mockT.send.mockResolvedValueOnce([
      { kind: 'api', message: "can't parse entities at byte offset 0" },
      null,
    ]);
    mockT.send.mockResolvedValueOnce({ message_id: 2 });
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message', content: { type: 'text', text: 'bad **markdown' } },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    // Should have retried without parse_mode
    const plainSend = mockT.send.mock.calls.find((c) => c[2] === undefined);
    expect(plainSend).toBeDefined();
  });

  it('sends stop reason placeholder when no output', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // No updates pushed — nextUpdate returns stop immediately
    acp.nextUpdate.mockResolvedValueOnce({ kind: 'stop', stopReason: 'max_tokens' });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, '[max_tokens]');
  });

  it('sends error message on prompt failure', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockRejectedValueOnce(new Error('connection lost'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, 'Error: connection lost');
  });

  it('sends error message when acp.prompt() rejects', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, 'Error: prompt failed');
  });

  it('ignores thoughts when showThoughts=false', async () => {
    const { bot, acp } = createBot({ showThoughts: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_thought', content: { type: 'text', text: 'thinking...' } },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    // No message sent because thought was ignored and no agent_message followed
    const sends = mockT.send.mock.calls.filter((c) => c[0] === 123 && c[1] !== '[end_turn]');
    expect(sends.length).toBe(0);
  });

  it('forwards thoughts when showThoughts=true', async () => {
    const { bot, acp } = createBot({ showThoughts: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_thought', content: { type: 'text', text: 'thinking...' } },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, 'thinking...', {
      parseMode: 'Markdown',
    });
  });

  it('auto-approves permission when agentCmd includes dangerous', async () => {
    const { bot } = createBot({ agentCmd: 'acp-agent --dangerous serve' });
    const result = await bot._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('opt1');
  });

  it('sends permission buttons when agentCmd has no dangerous', async () => {
    const { bot } = createBot({ agentCmd: 'acp-agent serve' });
    bot.currentChannelId = 123;
    const permissionPromise = bot._handlePermission({
      options: [
        { kind: 'allow', optionId: 'opt_allow' },
        { kind: 'reject', optionId: 'opt_reject' },
      ],
    });
    // Wait for sendMessage to resolve and permissionPending to be set
    await vi.advanceTimersByTimeAsync(0);
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Permission required'),
      expect.objectContaining({ keyboard: expect.any(Array) })
    );
    expect(bot.permissionPending).not.toBeNull();
    bot.permissionPending.resolve({ outcome: { outcome: 'selected', optionId: 'opt_allow' } });
    const result = await permissionPromise;
    expect(result.outcome.optionId).toBe('opt_allow');
  });

  it('delegates bridge commands to onCommand', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/cron list' });
    expect(onCommand).toHaveBeenCalledWith('/cron list', 123);
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('forwards to agent when onCommand returns false', async () => {
    const onCommand = vi.fn(async () => false);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/some-slash-command' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/some-slash-command');
  });

  it('enqueuePrompt adds to queue and processes', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    bot.enqueuePrompt('test prompt', 123);
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('test prompt');
  });

  it('enqueuePrompt with onComplete calls it with response after processing', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message', content: { type: 'text', text: 'Hello back' } },
    });
    const onComplete = vi.fn();
    bot.enqueuePrompt('test prompt', 123, undefined, onComplete);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onComplete).toHaveBeenCalledWith('Hello back', undefined);
  });

  it('enqueuePrompt with onComplete calls it with error on failure', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.prompt.mockRejectedValueOnce(new Error('agent crashed'));
    const onComplete = vi.fn();
    bot.enqueuePrompt('test prompt', 123, undefined, onComplete);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onComplete).toHaveBeenCalledWith('', 'agent crashed');
  });

  it('drops injected prompts when the queue is full', async () => {
    const { bot } = createBot();
    await bot.start();
    // biome-ignore lint/suspicious/noExplicitAny: protected members under test
    const b = bot as any;
    b.busy = true;
    for (let i = 0; i < 100; i++) b.queue.push({ channelId: 123, text: `q${i}` });
    const onComplete = vi.fn();
    await bot.enqueuePrompt('overflow', 123, undefined, onComplete, 'http');
    expect(onComplete).toHaveBeenCalledWith('', 'queue full');
    expect(b.queue.length).toBe(100);
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      '⚠️ Queue is full — try again later.',
      expect.anything()
    );
  });

  it('drops user messages when the queue is full', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // biome-ignore lint/suspicious/noExplicitAny: protected members under test
    const b = bot as any;
    b.busy = true;
    for (let i = 0; i < 100; i++) b.queue.push({ channelId: 123, text: `q${i}` });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'one more' });
    expect(b.queue.length).toBe(100);
    expect(acp.prompt).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      '⚠️ Queue is full — try again later.',
      expect.anything()
    );
  });

  it('truncates the 👤 log preview to logPreviewLength', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { bot } = createBot({ logPreviewLength: 30 });
      await bot.start();
      const handler = onMessage;
      await handler({ chat: { id: 123 }, message_id: 1, text: 'a'.repeat(100) });
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('👤'));
      expect(line).toBe(`👤 ${'a'.repeat(30)}…`);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('stop() stops polling', async () => {
    const { bot } = createBot();
    bot.stop();
    expect(mockT.stop).toHaveBeenCalled();
  });

  it('/stop when idle responds nothing to stop', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Nothing to stop.');
    expect(acp.cancel).not.toHaveBeenCalled();
  });

  it('/stop when busy cancels the agent', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // Start a prompt to make the bot busy
    acp.nextUpdate.mockReturnValue(new Promise(() => {})); // never resolves
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(acp.cancel).toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(123, '⏹ Stopped.');
  });

  it('/stop clears the queue', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'first' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    // Queue more items
    await handler({ chat: { id: 123 }, text: 'second' });
    await handler({ chat: { id: 123 }, text: 'third' });
    expect(bot.queue.length).toBe(2);
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(bot.queue.length).toBe(0);
  });

  it('/stop on cancel error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    acp.cancel.mockRejectedValueOnce(new Error('agent unreachable'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Stop failed: agent unreachable');
  });

  it('/new when idle creates new session', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions new' });
    expect(acp.newSession).toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(123, '🆕 New session started: `new-session-id`', {
      parseMode: 'Markdown',
    });
  });

  it('/new when busy refuses with message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/sessions new' });
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'Cannot start new session while busy. Use /stop first.',
      { parseMode: 'Markdown' }
    );
  });

  it('/sessions lists available sessions', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions' });
    expect(acp.listSessions).toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      '*Sessions:*\n  1. Session 1\n  2. s2\n\nSwitch with /sessions <n> or /sessions <id>.',
      { parseMode: 'Markdown' }
    );
  });

  it('/session <n> resolves the number against the last /sessions list', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions' });
    await handler({ chat: { id: 123 }, text: '/sessions 2' });
    expect(acp.loadSession).toHaveBeenCalledWith('s2');
  });

  it('/session <n> without a prior /sessions asks to list first', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions 2' });
    expect(acp.loadSession).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(123, 'Run /sessions first to get a numbered list.', {
      parseMode: 'Markdown',
    });
  });

  it('/session <n> out of range reports the list size', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions' });
    await handler({ chat: { id: 123 }, text: '/sessions 99' });
    expect(acp.loadSession).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'No session #99 — run /sessions to see 2 entries.',
      { parseMode: 'Markdown' }
    );
  });

  it('/sessions when not supported sends error', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.listSessions.mockRejectedValueOnce(new Error('Agent does not support session/list'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'Cannot list sessions: Agent does not support session/list',
      { parseMode: 'Markdown' }
    );
  });

  it('/session <id> switches session', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions abc-123' });
    expect(acp.loadSession).toHaveBeenCalledWith('abc-123');
    expect(mockT.send).toHaveBeenCalledWith(123, '🔄 Switched to session: `abc-123`', {
      parseMode: 'Markdown',
    });
  });

  it('/session without id sends usage', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions rm' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Usage: /sessions rm `<id>`', {
      parseMode: 'Markdown',
    });
  });

  it('/session when busy refuses with message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/sessions abc-123' });
    expect(acp.loadSession).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'Cannot switch session while busy. Use /stop first.',
      { parseMode: 'Markdown' }
    );
  });

  it('/new on error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.newSession.mockRejectedValueOnce(new Error('agent crashed'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions new' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Failed to create session: agent crashed', {
      parseMode: 'Markdown',
    });
  });

  it('/config mode lists modes as a synthetic option', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      '*`mode`* (Mode)\n▶ 1. Default\n  2. Bypass — Auto-approve all tool calls\n\nSet with /config mode <n> or <value>.',
      { parseMode: 'Markdown' }
    );
  });

  it('/config mode <id> switches mode via set_mode', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode bypass' });
    expect(acp.setSessionMode).toHaveBeenCalledWith('bypass');
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(123, '⚙️ `mode` set to: `bypass`', {
      parseMode: 'Markdown',
    });
  });

  it('/config mode <n> switches mode by index', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode 2' });
    expect(acp.setSessionMode).toHaveBeenCalledWith('bypass');
  });

  it('/config mode <unknown> sends available values', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode unknown' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Unknown value `unknown`. Available: default, bypass'),
      { parseMode: 'Markdown' }
    );
  });

  it('/config mode when no modes available reports unknown option', async () => {
    const { bot, acp } = createBot();
    acp.modes = null;
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode' });
    expect(mockT.send).toHaveBeenCalledWith(123, expect.stringContaining('Unknown option `mode`'), {
      parseMode: 'Markdown',
    });
  });

  it('/config mode on error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.setSessionMode.mockRejectedValueOnce(new Error('agent rejected'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode bypass' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Failed to set option: agent rejected', {
      parseMode: 'Markdown',
    });
  });

  it('a real mode configOption wins over the synthetic one', async () => {
    const { bot, acp } = createBot();
    acp.configOptions = [
      ...(acp.configOptions ?? []),
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }],
      },
    ];
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config mode default' });
    // real configOption path — set_config_option, not set_mode
    expect(acp.setConfigOption).toHaveBeenCalledWith('mode', 'default');
    expect(acp.setSessionMode).not.toHaveBeenCalled();
  });

  it('/config lists all config options with current values', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config' });
    expect(mockT.send).toHaveBeenCalledWith(123, expect.stringContaining('*Config options:*'), {
      parseMode: 'Markdown',
    });
    expect(mockT.send).toHaveBeenCalledWith(123, expect.stringContaining('`model`'), {
      parseMode: 'Markdown',
    });
    expect(mockT.send).toHaveBeenCalledWith(123, expect.stringContaining('`model-a`'), {
      parseMode: 'Markdown',
    });
  });

  it('/config <id> lists the option values numbered with current marker', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      '*`model`* (Model)\n▶ 1. Model A\n  2. Model B — Fast\n\nSet with /config model <n> or <value>.',
      { parseMode: 'Markdown' }
    );
  });

  it('/config <id> <n> sets the option by list index', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model 2' });
    expect(acp.setConfigOption).toHaveBeenCalledWith('model', 'model-b');
  });

  it('/config model <n> sets the model by list index', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model 1' });
    expect(acp.setConfigOption).toHaveBeenCalledWith('model', 'model-a');
  });

  it('/config <id> <n> out of range reports the list size', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model 9' });
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'No option #9 — run /config model to see 2 entries.',
      { parseMode: 'Markdown' }
    );
  });

  it('/config <id> <value> sets the option', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model model-b' });
    expect(acp.setConfigOption).toHaveBeenCalledWith('model', 'model-b');
    expect(mockT.send).toHaveBeenCalledWith(123, '⚙️ `model` set to: `model-b`', {
      parseMode: 'Markdown',
    });
  });

  it('/config model <value> sets the model', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model model-b' });
    expect(acp.setConfigOption).toHaveBeenCalledWith('model', 'model-b');
  });

  it('/config model without value lists model options', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model' });
    expect(mockT.send).toHaveBeenCalledWith(123, expect.stringContaining('2. Model B — Fast'), {
      parseMode: 'Markdown',
    });
  });

  it('/config <unknown> sends available option ids', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config nope' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Unknown option `nope`. Available: model, verbose, mode'),
      { parseMode: 'Markdown' }
    );
  });

  it('/config <id> <unknown value> sends available values', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model nope' });
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Unknown value `nope`. Available: model-a, model-b'),
      { parseMode: 'Markdown' }
    );
  });

  it('/config <boolean> true sets a boolean option', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config verbose true' });
    expect(acp.setConfigOption).toHaveBeenCalledWith('verbose', 'true');
  });

  it('/config <boolean> with non-boolean value sends hint', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config verbose maybe' });
    expect(acp.setConfigOption).not.toHaveBeenCalled();
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'Option `verbose` is boolean. Use: true or false',
      { parseMode: 'Markdown' }
    );
  });

  it('/config with no config options and no modes sends message', async () => {
    const { bot, acp } = createBot();
    acp.configOptions = null;
    acp.modes = null;
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'No config options reported by the agent.', {
      parseMode: 'Markdown',
    });
  });

  it('/config on error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.setConfigOption.mockRejectedValueOnce(new Error('agent rejected'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/config model model-b' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Failed to set option: agent rejected', {
      parseMode: 'Markdown',
    });
  });

  it('config_option_update refreshes acp.configOptions', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'model-b' }],
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'work' });
    await vi.waitFor(() => expect(acp.configOptions?.[0]?.currentValue).toBe('model-b'));
  });

  it('/help shows only bridge commands, not agent-advertised ones', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/help' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('/jobs add `[as <name>] <when> <prompt>`'),
      { parseMode: 'Markdown' }
    );
    const text = mockT.send.mock.calls[0][1];
    expect(text).toContain('*Commands:*');
    expect(text).not.toContain('Agent commands');
    expect(text).not.toContain('/compact');
    expect(text).not.toContain('/rename');
  });

  it('available_commands_update refreshes acp.availableCommands', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'newcmd', description: 'A new command' }],
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'work' });
    await vi.waitFor(() => expect(acp.availableCommands?.[0]?.name).toBe('newcmd'));
  });

  // --- Typing indicator ---

  it('sends typing action while processing a prompt', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'work' });
    await vi.waitFor(() => expect(mockT.typing).toHaveBeenCalledWith(123));
  });

  it('keeps typing while busy (interval resend)', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {})); // never stops
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    expect(mockT.typing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4500);
    expect(mockT.typing).toHaveBeenCalledTimes(2);
  });

  // --- Agent exit / reconnect ---

  it('notifyAgentExit sends a reconnect button to allowed chats', async () => {
    const { bot } = createBot();
    await bot.start();
    await bot.notifyAgentExit(1);
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining('connection lost'),
      expect.objectContaining({
        keyboard: [[{ text: '🔄 Reconnect', callback_data: 'reconnect' }]],
      })
    );
  });

  it('reconnect button triggers acp.restart and confirms', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'reconnect',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'private' }, message_id: 42 },
    });
    expect(acp.restart).toHaveBeenCalled();
    expect(mockT.edit).toHaveBeenCalledWith(
      123,
      42,
      expect.stringContaining('Agent reconnected'),
      expect.objectContaining({ parseMode: 'Markdown' })
    );
  });

  it('denies permission callbacks from non-operator users in groups', async () => {
    const { bot } = createBot({ allowedUserIds: [555] });
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 42 };
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'perm_allow_opt1',
      from: { id: 999 },
      message: { chat: { id: 123, type: 'group' }, message_id: 42 },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(mockT.answerCallback).toHaveBeenCalledWith('q1', '⛔ Not authorized', true);
  });

  it('denies group callbacks when allowedUserIds is empty', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 42 };
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'perm_deny_opt1',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'supergroup' }, message_id: 42 },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows permission callbacks from allowlisted users in groups', async () => {
    const { bot } = createBot({ allowedUserIds: [555] });
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 42 };
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'perm_allow_opt1',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'group' }, message_id: 42 },
    });
    expect(resolve).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'opt1' },
    });
  });

  it('allows permission callbacks in private chats without allowlist', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 42 };
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'perm_allow_opt1',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'private' }, message_id: 42 },
    });
    expect(resolve).toHaveBeenCalled();
  });

  it('rejects permission callbacks from a stale message', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 42 };
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'perm_allow_opt1',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'private' }, message_id: 99 },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(mockT.answerCallback).toHaveBeenCalledWith(
      'q1',
      '⌛ Permission request expired',
      undefined
    );
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    expect((bot as any).permissionPending).not.toBeNull();
  });

  it('reconnect failure edits the message with the error', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.restart.mockRejectedValueOnce(new Error('spawn failed'));
    const cbHandler = onCallback;
    await cbHandler({
      id: 'q1',
      data: 'reconnect',
      from: { id: 555 },
      message: { chat: { id: 123, type: 'private' }, message_id: 42 },
    });
    expect(mockT.edit).toHaveBeenCalledWith(
      123,
      42,
      expect.stringContaining('Reconnect failed: spawn failed')
    );
  });

  // --- Tool call updates ---

  it('renders tool_call update when showTools is true', async () => {
    const { bot, acp } = createBot({ showTools: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-123',
        title: 'Read file',
        status: 'in_progress',
        kind: 'read',
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    const text = calls.map((c) => c[1]).join('');
    expect(text).toContain('Read file');
    expect(text).toContain('in_progress');
  });

  it('hides tool_call update when showTools is false', async () => {
    const { bot, acp } = createBot({ showTools: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-123',
        title: 'Read file',
        status: 'in_progress',
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123 && typeof c[1] === 'string');
    const text = calls.map((c) => c[1]).join('');
    expect(text).not.toContain('Read file');
  });

  it('renders tool_call_update with updated status', async () => {
    const { bot, acp } = createBot({ showTools: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-456',
        title: 'Run tests',
        status: 'pending',
      },
    });
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-456',
        status: 'completed',
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    const text = calls.map((c) => c[1]).join('');
    expect(text).toContain('Run tests');
    expect(text).toContain('completed');
  });

  // --- Plan updates ---

  it('renders plan update when showPlan is true', async () => {
    const { bot, acp } = createBot({ showPlan: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read file', status: 'completed' },
          { content: 'Write tests', status: 'pending' },
        ],
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    const text = calls.map((c) => c[1]).join('');
    expect(text).toContain('Read file');
    expect(text).toContain('Write tests');
  });

  it('hides plan update when showPlan is false', async () => {
    const { bot, acp } = createBot({ showPlan: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Read file', status: 'pending' }],
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123 && typeof c[1] === 'string');
    const text = calls.map((c) => c[1]).join('');
    expect(text).not.toContain('Read file');
  });

  // --- current_mode_update ---

  it('updates current mode on current_mode_update', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    expect(acp.modes?.currentModeId).toBe('default');
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'current_mode_update',
        modeId: 'bypass',
      },
    });
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.modes?.currentModeId).toBe('bypass');
  });

  // --- /delete command ---

  it('/sessions rm <id> deletes a session', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions rm other-session' });
    expect(acp.deleteSession).toHaveBeenCalledWith('other-session');
    expect(mockT.send).toHaveBeenCalledWith(123, '🗑 Deleted session: `other-session`', {
      parseMode: 'Markdown',
    });
  });

  it('/sessions rm without arg shows usage', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions rm' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Usage: /sessions rm `<id>`', {
      parseMode: 'Markdown',
    });
  });

  it('/sessions rm active session is rejected', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions rm test-session-id' });
    expect(mockT.send).toHaveBeenCalledWith(
      123,
      'Cannot delete the active session. Use /sessions new first.',
      { parseMode: 'Markdown' }
    );
  });

  it('/sessions rm on error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.deleteSession.mockRejectedValueOnce(new Error('agent rejected'));
    const handler = onMessage;
    await handler({ chat: { id: 123 }, text: '/sessions rm other-session' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Failed to delete session: agent rejected', {
      parseMode: 'Markdown',
    });
  });
});

describe('echoInjectedPrompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('echoes job-sourced prompt with job label', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    bot.enqueuePrompt('summarize today', 123, undefined, undefined, 'job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, '⏰ [job] summarize today');
    expect(acp.prompt).toHaveBeenCalledWith('summarize today');
  });

  it('echoes http-sourced prompt with http label', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.enqueuePrompt('what is the weather', 123, undefined, undefined, 'http');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, '🌐 [http] what is the weather');
  });

  it('echoes a2a-sourced prompt with a2a label', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.enqueuePrompt('review the latest PRs', 123, undefined, undefined, 'a2a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.send).toHaveBeenCalledWith(123, '🔁 [a2a] review the latest PRs');
  });

  it('does not echo when no source is provided (direct user message)', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    bot.enqueuePrompt('test prompt', 123);
    await vi.advanceTimersByTimeAsync(1000);
    // No echo message should be sent — only the agent response
    const calls = mockT.send.mock.calls.filter(
      (c) => c[1] !== 'Hello back' && c[1] !== 'test prompt'
    );
    expect(calls.some((c) => c[1]?.includes('[job]') || c[1]?.includes('[http]'))).toBe(false);
    expect(acp.prompt).toHaveBeenCalledWith('test prompt');
  });

  it('does not echo when echoInjectedPrompts is false', async () => {
    const { bot, acp } = createBot({ echoInjectedPrompts: false });
    await bot.start();
    bot.enqueuePrompt('summarize today', 123, undefined, undefined, 'job');
    await vi.advanceTimersByTimeAsync(1000);
    const echoCalls = mockT.send.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('[job]')
    );
    expect(echoCalls).toHaveLength(0);
    expect(acp.prompt).toHaveBeenCalledWith('summarize today');
  });

  it('truncates long prompts in echo to 200 chars', async () => {
    const { bot } = createBot();
    await bot.start();
    const longPrompt = 'a'.repeat(250);
    bot.enqueuePrompt(longPrompt, 123, undefined, undefined, 'job');
    await vi.advanceTimersByTimeAsync(1000);
    const echoCall = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('[job]')
    );
    expect(echoCall).toBeDefined();
    // "⏰ [job] " (9 chars) + 200 'a' + "…" = 210
    expect(echoCall[1]).toBe(`⏰ [job] ${'a'.repeat(200)}…`);
  });

  it('defaults to true when not specified', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.enqueuePrompt('test', 123, undefined, undefined, 'job');
    await vi.advanceTimersByTimeAsync(1000);
    const echoCall = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('[job]')
    );
    expect(echoCall).toBeDefined();
  });
});

describe('queued reaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds 😴 reaction to user message while bot is busy', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;

    // Keep the first prompt blocked so the bot stays busy
    let release: ((v: MockAcpUpdate) => void) | undefined;
    acp.nextUpdate.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    await handler({ chat: { id: 123 }, message_id: 1, text: 'first prompt' });
    await handler({ chat: { id: 123 }, message_id: 2, text: 'second prompt' });

    expect(mockT.react).toHaveBeenCalledWith(123, 2, '😴');
    release?.({ kind: 'stop', stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('clears the reaction when the queued item starts processing', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;

    let release: ((v: MockAcpUpdate) => void) | undefined;
    acp.nextUpdate.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    await handler({ chat: { id: 123 }, message_id: 1, text: 'first prompt' });
    await handler({ chat: { id: 123 }, message_id: 2, text: 'second prompt' });

    release?.({ kind: 'stop', stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockT.react).toHaveBeenCalledWith(123, 2, '😴', true);
  });

  it('does not react when bot is not busy', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: 'hello' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockT.react).not.toHaveBeenCalled();
  });
});

describe('reply-to context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prepends replied-to message text as context', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: 123 },
      message_id: 2,
      text: 'what do you mean?',
      reply_to_message: { text: 'earlier message', from: { username: 'gali' } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith(
      '[in reply to @gali: "earlier message"] what do you mean?'
    );
  });

  it('omits author when replied message has no username', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: 123 },
      message_id: 2,
      text: 'ok?',
      reply_to_message: { text: 'quoted text', from: {} },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('[in reply to: "quoted text"] ok?');
  });

  it('ignores replies to messages with no text or caption', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: 123 },
      message_id: 2,
      text: 'plain prompt',
      reply_to_message: { photo: [{ file_id: 'x' }] },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('plain prompt');
  });

  it('truncates long quoted text at 300 chars', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({
      chat: { id: 123 },
      message_id: 2,
      text: 'sure',
      reply_to_message: { text: 'q'.repeat(400), from: {} },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith(`[in reply to: "${'q'.repeat(300)}…"] sure`);
  });
});

describe('/queue and /status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function blockAgent(acp: MockAcp) {
    let release: ((v: MockAcpUpdate) => void) | undefined;
    acp.nextUpdate.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    return () => release?.({ kind: 'stop', stopReason: 'end_turn' });
  }

  it('/queue lists pending prompts', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    const unblock = blockAgent(acp);
    await handler({ chat: { id: 123 }, message_id: 1, text: 'busy prompt' });
    await handler({ chat: { id: 123 }, message_id: 2, text: 'queued one' });
    await handler({ chat: { id: 123 }, message_id: 3, text: 'queued two' });

    await handler({ chat: { id: 123 }, message_id: 4, text: '/queue' });
    const call = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Queued prompts')
    );
    expect(call).toBeDefined();
    expect(call[1]).toContain('1. queued one');
    expect(call[1]).toContain('2. queued two');
    unblock();
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('/queue on empty queue reports empty', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/queue' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Queue is empty.', {
      parseMode: 'Markdown',
    });
  });

  it('/queue cancel removes the item at position', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    const unblock = blockAgent(acp);
    await handler({ chat: { id: 123 }, message_id: 1, text: 'busy prompt' });
    await handler({ chat: { id: 123 }, message_id: 2, text: 'first queued' });
    await handler({ chat: { id: 123 }, message_id: 3, text: 'second queued' });

    await handler({ chat: { id: 123 }, message_id: 4, text: '/queue cancel 1' });
    expect(mockT.send).toHaveBeenCalledWith(123, '🗑 Cancelled queued prompt 1: first queued', {
      parseMode: 'Markdown',
    });
    // Cleared the queued reaction on the removed item
    expect(mockT.react).toHaveBeenCalledWith(123, 2, '😴', true);
    unblock();
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('/queue rm with invalid index shows usage', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/queue cancel 9' });
    expect(mockT.send).toHaveBeenCalledWith(123, 'Usage: /queue rm `<position>`', {
      parseMode: 'Markdown',
    });
  });

  it('/queue clear removes all pending prompts', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = onMessage;
    const unblock = blockAgent(acp);
    await handler({ chat: { id: 123 }, message_id: 1, text: 'busy prompt' });
    await handler({ chat: { id: 123 }, message_id: 2, text: 'one' });
    await handler({ chat: { id: 123 }, message_id: 3, text: 'two' });

    await handler({ chat: { id: 123 }, message_id: 4, text: '/queue clear' });
    expect(mockT.send).toHaveBeenCalledWith(123, '🗑 Cleared 2 queued prompt(s).', {
      parseMode: 'Markdown',
    });
    unblock();
    await vi.advanceTimersByTimeAsync(1000);
    // Only the first prompt was processed — the queue stayed cleared
    expect(acp.prompt).toHaveBeenCalledTimes(1);
  });

  it('/status reports agent state, session, queue and uptime', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/status' });
    const call = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('agent:')
    );
    expect(call).toBeDefined();
    expect(call[1]).toContain('acp-connector');
    expect(call[1]).toContain('queue: 0 pending');
    expect(call[1]).toContain('session:');
    expect(call[1]).toContain('`test-session-id`');
    expect(call[1]).toContain('up ');
    expect(call[1]).toContain('`acp-agent serve`');
  });

  it('/status includes jobs and a2a summaries when provided', async () => {
    const { bot } = createBot({
      jobsSummary: () => '2 job(s) (1 once · 1 manual) — next "standup" in 3h',
      networkSummary: () => '2 approved · 1 pending',
    });
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/status' });
    const call = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('agent:')
    );
    expect(call[1]).toContain('⏰ 2 job(s) (1 once · 1 manual) — next "standup" in 3h');
    expect(call[1]).toContain('🌐 a2a: 2 approved · 1 pending');
  });

  it('/status appends the session title when the agent lists it', async () => {
    const { bot, acp } = createBot();
    acp.sessionId = 's1';
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/status' });
    const call = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('session:')
    );
    expect(call[1]).toContain('`s1` — "Session 1"');
  });

  it('/status still answers when session/list is unsupported', async () => {
    const { bot, acp } = createBot();
    acp.listSessions.mockRejectedValue(new Error('Agent does not support session/list'));
    await bot.start();
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/status' });
    const call = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('session:')
    );
    expect(call[1]).toContain('`test-session-id`');
    expect(call[1]).not.toContain('Session 1');
  });

  it('sendMessage splits text longer than 4096 chars into chunks', async () => {
    const { bot } = createBot();
    await bot.start();
    await bot.sendMessage(123, 'x'.repeat(5000));
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(calls.length).toBe(2);
    expect((calls[0][1] as string).length).toBe(4096);
    expect((calls[1][1] as string).length).toBe(904);
  });

  it('sendMessage prefers paragraph boundaries over hard cuts', async () => {
    const { bot } = createBot();
    await bot.start();
    const text = `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`;
    await bot.sendMessage(123, text);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(calls.length).toBe(2);
    expect((calls[0][1] as string).length).toBe(4000);
    expect((calls[1][1] as string).startsWith('\n\n')).toBe(true);
  });

  it('sendMessage prefers line boundaries when no paragraph break fits', async () => {
    const { bot } = createBot();
    await bot.start();
    const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`;
    await bot.sendMessage(123, text);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(calls.length).toBe(2);
    expect((calls[0][1] as string).length).toBe(3000);
  });

  it('sendMessage prefers space boundaries when no line break fits', async () => {
    const { bot } = createBot();
    await bot.start();
    const text = `${'a'.repeat(3000)} ${'b'.repeat(3000)}`;
    await bot.sendMessage(123, text);
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(calls.length).toBe(2);
    expect((calls[0][1] as string).length).toBe(3000);
  });

  it('sendMessage threads continuation chunks as replies to the first', async () => {
    const { bot } = createBot();
    await bot.start();
    mockT.send
      .mockResolvedValueOnce([null, { messageId: 101 }])
      .mockResolvedValueOnce([null, { messageId: 102 }]);
    await bot.sendMessage(123, 'x'.repeat(5000));
    const calls = mockT.send.mock.calls.filter((c) => c[0] === 123);
    expect(calls.length).toBe(2);
    const firstOpts = calls[0][2] as Record<string, unknown>;
    const secondOpts = calls[1][2] as Record<string, unknown>;
    expect(firstOpts.replyToId).toBeUndefined();
    expect(secondOpts.replyToId).toBe(101);
  });

  it('reports message handler errors without rejecting', async () => {
    const { bot } = createBot();
    await bot.start();
    mockT.send.mockResolvedValueOnce([{ kind: 'api', message: 'boom' }, null]);
    const handler = onMessage;
    await handler({ chat: { id: 123 }, message_id: 1, text: '/config model' });
    const report = mockT.send.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('⚠️')
    );
    expect(report).toBeDefined();
    expect(report?.[2]).toBeUndefined();
  });
});

describe('command source isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats http prompts as agent input by default: no commands run, prompt reaches the agent', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();

    await bot.enqueuePrompt('/a2a approve evil', 123, undefined, undefined, 'http');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/a2a approve evil');
  });

  it('runs commands for http prompts when httpCommandsAllowed is true', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    bot.httpCommandsAllowed = true;
    await bot.start();

    await bot.enqueuePrompt('/a2a status', 123, undefined, undefined, 'http');
    expect(onCommand).toHaveBeenCalled();
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('never runs commands for a2a content, even with httpCommandsAllowed', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    bot.httpCommandsAllowed = true;
    await bot.start();

    await bot.enqueuePrompt('/a2a approve evil', 123, undefined, undefined, 'a2a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/a2a approve evil');
  });

  it('never runs commands for agent-created job content', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();

    await bot.enqueuePrompt('/a2a approve evil', 123, undefined, undefined, 'agent-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/a2a approve evil');
  });

  it('never runs commands for agent-created reminder content', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();

    await bot.enqueuePrompt('/a2a approve evil', 123, undefined, undefined, 'agent-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/a2a approve evil');
  });

  it('agent-job content stays remote even when it mimics an operator command', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();

    await bot.enqueuePrompt('/jobs rm 1', 123, undefined, undefined, 'agent-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).not.toHaveBeenCalled();
    expect(acp.prompt).toHaveBeenCalledWith('/jobs rm 1');
  });

  it('runs commands for operator job content', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();

    await bot.enqueuePrompt('/jobs list', 123, undefined, undefined, 'job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand).toHaveBeenCalled();
    expect(acp.prompt).not.toHaveBeenCalled();
  });
});
