import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock discord.js
const mockChannel: {
  send: ReturnType<typeof vi.fn>;
} = {
  send: vi.fn(async (_content: unknown) => ({ id: '1', edit: vi.fn(async () => ({})) })),
};

const mockClient: {
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  channels: { cache: { get: ReturnType<typeof vi.fn> } };
} = {
  on: vi.fn(),
  login: vi.fn(async () => {}),
  destroy: vi.fn(),
  channels: {
    cache: {
      get: vi.fn(() => mockChannel),
    },
  },
};

vi.mock('discord.js', () => ({
  Client: class MockClient {
    on = mockClient.on;
    login = mockClient.login;
    destroy = mockClient.destroy;
    channels = mockClient.channels;
  },
  Events: {
    MessageCreate: 'messageCreate',
    InteractionCreate: 'interactionCreate',
    Error: 'error',
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
  ActionRowBuilder: class MockActionRow {
    addComponents = vi.fn(() => this);
  },
  ButtonBuilder: class MockButton {
    setCustomId = vi.fn(() => this);
    setLabel = vi.fn(() => this);
    setStyle = vi.fn(() => this);
  },
  ButtonStyle: { Success: 3, Danger: 4 },
  ChannelType: { GuildText: 0, DM: 1, GroupDM: 3 },
}));

// Mock ACP client
function createMockAcp() {
  const updates: unknown[] = [];
  return {
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift();
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => {}),
    _pushUpdate: (update: unknown) => updates.push(update),
    _updates: updates,
  };
}

const { DiscordBot: DiscordBotClass } = await import('../src/discord.ts');

function createBot(overrides: Partial<ConstructorParameters<typeof DiscordBotClass>[0]> = {}) {
  const acp = createMockAcp();
  const bot = new DiscordBotClass({
    acp,
    token: 'test-token',
    allowedChannelIds: ['123'],
    agentCmd: 'acp-agent serve',
    ...overrides,
  });
  return { bot, acp };
}

interface MockMessage {
  author: { bot: boolean };
  channel: { id: string; send: ReturnType<typeof vi.fn> };
  content: string;
}

function makeMessage(channelId: string | number, content: string, authorBot = false): MockMessage {
  return {
    author: { bot: authorBot },
    channel: { id: String(channelId), send: mockChannel.send },
    content,
  };
}

interface MockInteraction {
  isButton: () => boolean;
  channel: { id: string; type: number };
  message: { id: string };
  customId: string;
  user: { id: string };
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
}

function makeInteraction(overrides: Partial<MockInteraction> = {}): MockInteraction {
  return {
    isButton: () => true,
    channel: { id: '123', type: 1 },
    message: { id: 'm1' },
    customId: 'perm_allow_opt1',
    user: { id: 'u1' },
    reply: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    editReply: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('DiscordBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and logs in', async () => {
    const { bot } = createBot();
    await bot.start();
    expect(mockClient.login).toHaveBeenCalledWith('test-token');
    expect(mockClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(mockClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
  });

  it('rejects unauthorized channel ID', async () => {
    const { bot } = createBot({ allowedChannelIds: ['123'] });
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('999', 'hello'));
    expect(mockChannel.send).not.toHaveBeenCalledWith('hello');
  });

  it('responds with channel ID in setup mode (empty allowlist)', async () => {
    const { bot } = createBot({ allowedChannelIds: [] });
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('999', 'hello'));
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.stringContaining('Your channel ID is: 999')
    );
  });

  it('ignores bot messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hello', true));
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('forwards allowed messages to ACP', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hello agent'));
    expect(acp.prompt).toHaveBeenCalledWith('hello agent');
  });

  it('handles /start and /help commands', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', '/help'));
    expect(acp.prompt).not.toHaveBeenCalled();
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('acp-connector') })
    );
  });

  it('ignores empty text', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', ''));
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('enqueues prompts from external sources', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await bot.enqueuePrompt('cron task', '123');
    expect(acp.prompt).toHaveBeenCalledWith('cron task');
  });

  it('streams agent response chunks', async () => {
    const { bot, acp } = createBot({ streaming: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    });
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } },
    });

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    // Flush stream timer
    await vi.advanceTimersByTimeAsync(800);
    await vi.runAllTimersAsync();

    expect(mockChannel.send).toHaveBeenCalledWith(expect.stringContaining('Hello world'));
  });

  it('handles agent_message (non-chunk)', async () => {
    const { bot, acp } = createBot({ streaming: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'agent_message',
        content: [{ text: 'Final response' }],
      },
    });

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    expect(acp.prompt).toHaveBeenCalledWith('hi');
  });

  it('sends error message on prompt failure', async () => {
    const { bot, acp } = createBot();
    acp.prompt = vi.fn(() => {
      throw new Error('agent crashed');
    });
    await bot.start();

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.stringContaining('Error: agent crashed')
      );
    });
  });

  it('sends error message when acp.prompt() rejects asynchronously', async () => {
    const { bot, acp } = createBot();
    acp.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    await bot.start();

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.stringContaining('Error: prompt failed')
      );
    });
  });

  it('auto-approves permission when agentCmd includes dangerous', async () => {
    const { bot } = createBot({ agentCmd: 'agent --dangerous acp' });
    const result = await bot._handlePermission({
      options: [{ optionId: 'allow_1', kind: 'allow' }],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('allow_1');
  });

  it('cancels permission when no options', async () => {
    const { bot } = createBot();
    const result = await bot._handlePermission({ options: [] });
    expect(result.outcome.outcome).toBe('cancelled');
  });

  it('auto-approves when no current channel', async () => {
    const { bot } = createBot();
    const result = await bot._handlePermission({
      options: [{ optionId: 'allow_1', kind: 'allow' }],
    });
    expect(result.outcome.outcome).toBe('selected');
  });

  it('sends permission buttons when channel is active', async () => {
    const { bot, acp } = createBot();
    await bot.start();

    // Make nextUpdate hang so currentChannelId stays set
    let resolveNextUpdate: ((value: unknown) => void) | undefined;
    acp.nextUpdate = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveNextUpdate = resolve;
        })
    );

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    handler(makeMessage('123', 'hi'));

    // Wait for prompt to be called (queue is processing)
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());

    // Now currentChannelId should be set
    const result = bot._handlePermission({
      options: [
        { optionId: 'allow_1', kind: 'allow' },
        { optionId: 'reject_1', kind: 'reject' },
      ],
    });
    expect(result).toBeInstanceOf(Promise);
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Permission required') })
    );

    // Cleanup
    if (resolveNextUpdate) resolveNextUpdate({ kind: 'stop', stopReason: 'end_turn' });
  });

  it('ignores thoughts when showThoughts=false', async () => {
    const { bot, acp } = createBot({ showThoughts: false });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    });

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    // Should not have sent 'thinking' — only empty or nothing
    const calls = mockChannel.send.mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toContain('thinking');
    }
  });

  it('forwards thoughts when showThoughts=true', async () => {
    const { bot, acp } = createBot({ showThoughts: true, streaming: true });
    await bot.start();
    acp._pushUpdate({
      kind: 'update',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    });

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    await vi.advanceTimersByTimeAsync(800);
    await vi.runAllTimersAsync();

    expect(mockChannel.send).toHaveBeenCalledWith(expect.stringContaining('thinking'));
  });

  it('sends stop reason when response is empty', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate = vi.fn(async () => ({ kind: 'stop', stopReason: 'max_tokens' }));

    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith('[max_tokens]');
    });
  });

  it('stop() destroys the client', () => {
    const { bot } = createBot();
    bot.stop();
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('sendMessage sends to the channel', async () => {
    const { bot } = createBot();
    await bot.sendMessage('123', 'hello from cron');
    expect(mockChannel.send).toHaveBeenCalledWith({ content: 'hello from cron' });
  });

  it('handles onCommand callback', async () => {
    const onCommand = vi.fn(async () => true);
    const { bot, acp } = createBot({ onCommand });
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', '/custom'));
    expect(onCommand).toHaveBeenCalledWith('/custom', '123');
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('/stop when idle responds nothing to stop', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', '/stop'));
    expect(mockChannel.send).toHaveBeenCalledWith('Nothing to stop.');
    expect(acp.cancel).not.toHaveBeenCalled();
  });

  it('/stop when busy cancels the agent', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'long task'));
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler(makeMessage('123', '/stop'));
    expect(acp.cancel).toHaveBeenCalled();
    expect(mockChannel.send).toHaveBeenCalledWith('⏹ Stopped.');
  });

  it('/stop clears the queue', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', 'first'));
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await handler(makeMessage('123', 'second'));
    await handler(makeMessage('123', 'third'));
    expect(bot.queue.length).toBe(2);
    await handler(makeMessage('123', '/stop'));
    expect(bot.queue.length).toBe(0);
  });

  it('sendMessage splits text longer than 2000 chars into chunks', async () => {
    const { bot } = createBot();
    await bot.start();
    await bot.sendMessage('123', 'x'.repeat(4500));
    const sends = mockChannel.send.mock.calls
      .map((c) => c[0])
      .filter(
        (a): a is { content: string } => typeof a === 'object' && a !== null && 'content' in a
      );
    expect(sends.length).toBe(3);
    expect(sends[0].content.length).toBe(2000);
    expect(sends[1].content.length).toBe(2000);
    expect(sends[2].content.length).toBe(500);
  });

  it('sendMessage prefers paragraph boundaries and threads replies', async () => {
    const { bot } = createBot();
    await bot.start();
    let id = 100;
    mockChannel.send.mockImplementation(async (content: unknown) => ({
      id: String(++id),
      edit: vi.fn(async () => ({})),
      content,
    }));
    const text = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    await bot.sendMessage('123', text);
    const sends = mockChannel.send.mock.calls.filter(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'content' in (c[0] as object)
    );
    expect(sends.length).toBe(2);
    const first = sends[0][0] as { content: string; reply?: unknown };
    const second = sends[1][0] as {
      content: string;
      reply?: { messageReference?: string };
      allowedMentions?: { repliedUser?: boolean };
    };
    expect(first.content.length).toBe(1500);
    expect(first.reply).toBeUndefined();
    expect(second.content.startsWith('\n\n')).toBe(true);
    expect(second.reply?.messageReference).toBe('101');
    expect(second.allowedMentions?.repliedUser).toBe(false);
  });

  it('denies permission interactions from non-operator users in guilds', async () => {
    const { bot } = createBot({ allowedUserIds: ['u1'] });
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'interactionCreate')[1] as (
      i: MockInteraction
    ) => Promise<void>;
    const interaction = makeInteraction({
      channel: { id: '123', type: 0 },
      user: { id: 'u2' },
    });
    await handler(interaction);
    expect(resolve).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('denies guild interactions when allowedUserIds is empty', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'interactionCreate')[1] as (
      i: MockInteraction
    ) => Promise<void>;
    const interaction = makeInteraction({ channel: { id: '123', type: 0 } });
    await handler(interaction);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows permission interactions from allowlisted users in guilds', async () => {
    const { bot } = createBot({ allowedUserIds: ['u1'] });
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'interactionCreate')[1] as (
      i: MockInteraction
    ) => Promise<void>;
    const interaction = makeInteraction({ channel: { id: '123', type: 0 } });
    await handler(interaction);
    expect(resolve).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'opt1' },
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Allowed') })
    );
  });

  it('allows permission interactions in DMs without allowlist', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'interactionCreate')[1] as (
      i: MockInteraction
    ) => Promise<void>;
    await handler(makeInteraction());
    expect(resolve).toHaveBeenCalled();
  });

  it('rejects permission interactions from a stale message', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'interactionCreate')[1] as (
      i: MockInteraction
    ) => Promise<void>;
    const interaction = makeInteraction({ message: { id: 'old-msg' } });
    await handler(interaction);
    expect(resolve).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⌛ Permission request expired', ephemeral: true })
    );
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    expect((bot as any).permissionPending).not.toBeNull();
  });

  it('reports message handler errors without rejecting', async () => {
    const { bot } = createBot();
    await bot.start();
    mockChannel.send.mockRejectedValueOnce(new Error('boom'));
    const handler = mockClient.on.mock.calls.find((c) => c[0] === 'messageCreate')[1] as (
      msg: MockMessage
    ) => Promise<void>;
    await handler(makeMessage('123', '/model'));
    const report = mockChannel.send.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('⚠️')
    );
    expect(report).toBeDefined();
  });
});
