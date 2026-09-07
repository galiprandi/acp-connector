import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClient } from '../src/acp-client';

type MockFn = ReturnType<typeof vi.fn>;

interface MockBot {
  on: MockFn;
  sendMessage: MockFn;
  editMessageText: MockFn;
  answerCallbackQuery: MockFn;
  stopPolling: MockFn;
}

// Mock node-telegram-bot-api
const mockBot: MockBot = {
  on: vi.fn(),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  editMessageText: vi.fn(async () => ({})),
  answerCallbackQuery: vi.fn(async () => ({})),
  stopPolling: vi.fn(),
};

vi.mock('node-telegram-bot-api', () => ({
  default: class MockTelegramBot {
    on = mockBot.on;
    sendMessage = mockBot.sendMessage;
    editMessageText = mockBot.editMessageText;
    answerCallbackQuery = mockBot.answerCallbackQuery;
    stopPolling = mockBot.stopPolling;
  },
}));

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
  sessionId: string | null;
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
    sessionId: 'test-session-id',
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
    telegramToken: 'test-token',
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
    expect(mockBot.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith('callback_query', expect.any(Function));
  });

  it('rejects unauthorized chat ID', async () => {
    const { bot } = createBot({ allowedChatIds: [123] });
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 999 }, text: 'hello' });
    expect(mockBot.sendMessage).not.toHaveBeenCalledWith(999, expect.anything());
  });

  it('responds with chat ID in setup mode (empty allowlist)', async () => {
    const { bot } = createBot({ allowedChatIds: [] });
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 999 }, text: 'hello' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining('Your chat ID is: 999')
    );
  });

  it('rejects non-text messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, photo: [{ file_id: 'x' }] });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Media no soportado');
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('queues and forwards text to ACP', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hello agent' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acp.prompt).toHaveBeenCalledWith('hello agent');
  });

  it('streams agent_message_chunk and edits single message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    });
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Hello', { parse_mode: 'Markdown' });
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
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Full response', {
      parse_mode: 'Markdown',
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
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(2000);
    // First message (send) + overflow chunks (send)
    const sends = mockBot.sendMessage.mock.calls.filter((c) => c[0] === 123);
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to plain text on markdown parse error', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    mockBot.sendMessage.mockRejectedValueOnce(new Error("can't parse entities at byte offset 0"));
    mockBot.sendMessage.mockResolvedValueOnce({ message_id: 2 });
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message', content: { type: 'text', text: 'bad **markdown' } },
    });
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    // Should have retried without parse_mode
    const plainSend = mockBot.sendMessage.mock.calls.find((c) => c[2] === undefined);
    expect(plainSend).toBeDefined();
  });

  it('sends stop reason placeholder when no output', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // No updates pushed — nextUpdate returns stop immediately
    acp.nextUpdate.mockResolvedValueOnce({ kind: 'stop', stopReason: 'max_tokens' });
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, '[max_tokens]');
  });

  it('sends error message on prompt failure', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockRejectedValueOnce(new Error('connection lost'));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Error: connection lost');
  });

  it('sends error message when acp.prompt() rejects', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Error: prompt failed');
  });

  it('ignores thoughts when showThoughts=false', async () => {
    const { bot, acp } = createBot({ showThoughts: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_thought', content: { type: 'text', text: 'thinking...' } },
    });
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    // No message sent because thought was ignored and no agent_message followed
    const sends = mockBot.sendMessage.mock.calls.filter(
      (c) => c[0] === 123 && c[1] !== '[end_turn]'
    );
    expect(sends.length).toBe(0);
  });

  it('forwards thoughts when showThoughts=true', async () => {
    const { bot, acp } = createBot({ showThoughts: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_thought', content: { type: 'text', text: 'thinking...' } },
    });
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'thinking...', {
      parse_mode: 'Markdown',
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
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Permiso requerido'),
      expect.objectContaining({ reply_markup: expect.any(Object) })
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
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/cron list' });
    expect(onCommand).toHaveBeenCalledWith('/cron list', 123);
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('forwards to agent when onCommand returns false', async () => {
    const onCommand = vi.fn(async () => false);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
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

  it('stop() stops polling', async () => {
    const { bot } = createBot();
    bot.stop();
    expect(mockBot.stopPolling).toHaveBeenCalled();
  });

  it('/stop when idle responds nothing to stop', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Nothing to stop.');
    expect(acp.cancel).not.toHaveBeenCalled();
  });

  it('/stop when busy cancels the agent', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // Start a prompt to make the bot busy
    acp.nextUpdate.mockReturnValue(new Promise(() => {})); // never resolves
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(acp.cancel).toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, '⏹ Stopped.');
  });

  it('/stop clears the queue', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
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
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/stop' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Stop failed: agent unreachable');
  });

  it('/new when idle creates new session', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/new' });
    expect(acp.newSession).toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      '🆕 New session started: `new-session-id`',
      { parse_mode: 'Markdown' }
    );
  });

  it('/new when busy refuses with message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/new' });
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      'Cannot start new session while busy. Use /stop first.',
      { parse_mode: 'Markdown' }
    );
  });

  it('/sessions lists available sessions', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/sessions' });
    expect(acp.listSessions).toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('s1'), {
      parse_mode: 'Markdown',
    });
  });

  it('/sessions when not supported sends error', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.listSessions.mockRejectedValueOnce(new Error('Agent does not support session/list'));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/sessions' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      'Cannot list sessions: Agent does not support session/list',
      { parse_mode: 'Markdown' }
    );
  });

  it('/session <id> switches session', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/session abc-123' });
    expect(acp.loadSession).toHaveBeenCalledWith('abc-123');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, '🔄 Switched to session: `abc-123`', {
      parse_mode: 'Markdown',
    });
  });

  it('/session without id sends usage', async () => {
    const { bot } = createBot();
    await bot.start();
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/session' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'Usage: /session `<id>`', {
      parse_mode: 'Markdown',
    });
  });

  it('/session when busy refuses with message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: 'long task' });
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler({ chat: { id: 123 }, text: '/session abc-123' });
    expect(acp.loadSession).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      'Cannot switch session while busy. Use /stop first.',
      { parse_mode: 'Markdown' }
    );
  });

  it('/new on error sends error message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.newSession.mockRejectedValueOnce(new Error('agent crashed'));
    const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
    await handler({ chat: { id: 123 }, text: '/new' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      'Failed to create session: agent crashed',
      { parse_mode: 'Markdown' }
    );
  });
});
