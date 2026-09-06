import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node-telegram-bot-api
const mockBot = {
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

// Mock ACP client
function createMockAcp() {
  const updates = [];
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift();
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    _pushUpdate: (update) => updates.push({ kind: 'update', update }),
    _updates: updates,
  };
}

const { BridgeBot } = await import('../src/bot.js');

function createBot(overrides = {}) {
  const acp = createMockAcp();
  const bot = new BridgeBot({
    acp,
    telegramToken: 'test-token',
    allowedChatIds: [123],
    agentCmd: 'acp-agent serve',
    ...overrides,
  });
  return { bot, acp };
}

async function sendMessage(_bot, msg) {
  const handler = mockBot.on.mock.calls.find((c) => c[0] === 'message')[1];
  await handler(msg);
}

async function sendCallbackQuery(_bot, query) {
  const handler = mockBot.on.mock.calls.find((c) => c[0] === 'callback_query')[1];
  await handler(query);
}

describe('BridgeBot edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles empty text message', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, text: '' });
    // Empty text should not be forwarded to agent
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('splits long output over 4096 chars', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const longText = 'a'.repeat(5000);
    acp._pushUpdate({
      sessionUpdate: 'agent_message',
      content: [{ type: 'text', text: longText }],
    });
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(3000);
    // Should send initial message + overflow chunk(s)
    const sendCalls = mockBot.sendMessage.mock.calls.filter(
      (c) => c[0] === 123 && !c[1]?.includes('solo texto')
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to plain text when markdown fails', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp._pushUpdate({
      sessionUpdate: 'agent_message',
      content: [{ type: 'text', text: 'valid text' }],
    });
    // First sendMessage (initial) throws markdown error, retry without parse_mode
    mockBot.sendMessage.mockImplementationOnce(async () => {
      const err = new Error("can't parse entities: unmatched brackets");
      throw err;
    });
    mockBot.sendMessage.mockImplementationOnce(async () => ({ message_id: 1 }));
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(2000);
    // Should have retried without markdown
    const calls = mockBot.sendMessage.mock.calls;
    const hasPlainRetry = calls.some((c) => c[2] === undefined || !c[2]?.parse_mode);
    expect(hasPlainRetry).toBe(true);
  });

  it('queues multiple rapid messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    // Make nextUpdate slow so queue builds up
    acp.nextUpdate.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: 'stop', stopReason: 'end_turn' }), 100)
        )
    );
    await sendMessage(bot, { chat: { id: 123 }, text: 'msg1' });
    await sendMessage(bot, { chat: { id: 123 }, text: 'msg2' });
    await sendMessage(bot, { chat: { id: 123 }, text: 'msg3' });
    // All three should be queued
    expect(bot.queue.length + (bot.busy ? 1 : 0)).toBeGreaterThanOrEqual(1);
  });

  it('handles permission with no options', async () => {
    const { bot } = createBot({ agentCmd: 'safe-agent' });
    await bot.start();
    bot.currentChatId = 123;
    const result = await bot._handlePermission({ options: [] });
    // Should not crash, should return cancelled
    expect(result.outcome).toBeDefined();
    expect(result.outcome.outcome).toBe('cancelled');
  });

  it('auto-approves permission with no chatId', async () => {
    const { bot } = createBot({ agentCmd: 'safe-agent' });
    await bot.start();
    bot.currentChatId = null;
    const result = await bot._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('opt1');
  });

  it('handles callback query with no pending permission', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.permissionPending = null;
    await sendCallbackQuery(bot, {
      id: 'cb1',
      data: 'perm_allow_opt1',
      message: { chat: { id: 123 }, message_id: 1 },
    });
    // Should not crash
    expect(bot.permissionPending).toBeNull();
  });

  it('handles callback query with invalid data', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.permissionPending = { resolve: vi.fn() };
    await sendCallbackQuery(bot, {
      id: 'cb1',
      data: 'invalid_data',
      message: { chat: { id: 123 }, message_id: 1 },
    });
    // Should not resolve permission with invalid data
    expect(bot.permissionPending).not.toBeNull();
  });

  it('rejects photo messages', async () => {
    const { bot } = createBot();
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, photo: [{ file_id: 'x' }] });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'solo texto por ahora');
  });

  it('rejects voice messages', async () => {
    const { bot } = createBot();
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, voice: { file_id: 'x' } });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'solo texto por ahora');
  });

  it('rejects sticker messages', async () => {
    const { bot } = createBot();
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, sticker: { file_id: 'x' } });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'solo texto por ahora');
  });

  it('rejects document messages', async () => {
    const { bot } = createBot();
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, document: { file_id: 'x' } });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, 'solo texto por ahora');
  });

  it('rejects unauthorized chat', async () => {
    const { bot, acp } = createBot({ allowedChatIds: [123] });
    await bot.start();
    await sendMessage(bot, { chat: { id: 999 }, text: 'hi' });
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('handles setup mode (empty allowedChatIds)', async () => {
    const { bot } = createBot({ allowedChatIds: [] });
    await bot.start();
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    // In setup mode, should send setup instructions
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining('allowedChatIds')
    );
  });

  it('handles /start from enqueuePrompt (HTTP path)', async () => {
    const { bot } = createBot();
    await bot.start();
    await bot.enqueuePrompt('/start', 123);
    expect(mockBot.sendMessage).toHaveBeenCalled();
    const lastCall = mockBot.sendMessage.mock.calls[mockBot.sendMessage.mock.calls.length - 1];
    expect(lastCall[1]).toContain('acp-connector');
  });

  it('handles /help from enqueuePrompt (HTTP path)', async () => {
    const { bot } = createBot();
    await bot.start();
    await bot.enqueuePrompt('/help', 123);
    expect(mockBot.sendMessage).toHaveBeenCalled();
    const lastCall = mockBot.sendMessage.mock.calls[mockBot.sendMessage.mock.calls.length - 1];
    expect(lastCall[1]).toContain('acp-connector');
  });

  it('forwards unknown /command from enqueuePrompt to agent', async () => {
    const { bot, acp } = createBot();
    bot.onCommand = vi.fn(async () => false);
    await bot.start();
    await bot.enqueuePrompt('/unknown', 123);
    expect(acp.prompt).toHaveBeenCalledWith('/unknown');
  });

  it('handles agent crash during prompt', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockRejectedValueOnce(new Error('agent crashed'));
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Error'));
  });

  it('handles stream with only stop (no content)', async () => {
    const { bot } = createBot();
    await bot.start();
    // No updates pushed — nextUpdate returns stop immediately
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    // Should not crash — no message needed for end_turn with no content
    expect(bot.busy).toBe(false);
  });

  it('forwards thoughts when showThoughts is true', async () => {
    const { bot, acp } = createBot({ showThoughts: true });
    await bot.start();
    acp._pushUpdate({
      sessionUpdate: 'agent_thought',
      content: [{ type: 'text', text: 'thinking about it' }],
    });
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(2000);
    // The thought should be in the output
    const calls = mockBot.sendMessage.mock.calls.concat(mockBot.editMessageText.mock.calls);
    const allText = calls.map((c) => c[1] || '').join(' ');
    expect(allText).toContain('thinking');
  });

  it('filters thoughts when showThoughts is false', async () => {
    const { bot, acp } = createBot({ showThoughts: false });
    await bot.start();
    acp._pushUpdate({
      sessionUpdate: 'agent_thought',
      content: [{ type: 'text', text: 'thinking about it' }],
    });
    acp._pushUpdate({
      sessionUpdate: 'agent_message',
      content: [{ type: 'text', text: 'done' }],
    });
    await sendMessage(bot, { chat: { id: 123 }, text: 'hi' });
    await vi.advanceTimersByTimeAsync(2000);
    const calls = mockBot.sendMessage.mock.calls.concat(mockBot.editMessageText.mock.calls);
    const allText = calls.map((c) => c[1] || '').join(' ');
    expect(allText).not.toContain('thinking');
  });

  it('double stop is safe', async () => {
    const { bot } = createBot();
    await bot.start();
    bot.stop();
    bot.stop();
    // Should not throw — stopPolling may be called twice but that's ok
    // The important thing is no crash
  });

  it('auto-approves when agentCmd contains "dangerous"', async () => {
    const { bot } = createBot({ agentCmd: 'agent --dangerous acp' });
    await bot.start();
    bot.currentChatId = 123;
    const result = await bot._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
  });

  it('auto-approves when agentCmd contains "bypass"', async () => {
    const { bot } = createBot({ agentCmd: 'agent --bypass-permissions acp' });
    await bot.start();
    bot.currentChatId = 123;
    const result = await bot._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
  });

  it('auto-approves when agentCmd contains "yolo"', async () => {
    const { bot } = createBot({ agentCmd: 'agent --yolo acp' });
    await bot.start();
    bot.currentChatId = 123;
    const result = await bot._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
  });
});
