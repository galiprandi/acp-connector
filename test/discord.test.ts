import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DiscordLike, DiscordTransport } from '../src/transport/discord';

// Mock discord.js (used by the transport for Events/ChannelType/builders)
const mockChannel = {
  send: vi.fn(async (_content: unknown) => ({ id: '1', edit: vi.fn(async () => ({})) })),
  sendTyping: vi.fn(async () => {}),
  messages: {
    fetch: vi.fn(async () => ({
      id: '1',
      edit: vi.fn(async () => ({})),
      react: vi.fn(async () => ({})),
      reactions: {
        cache: { get: vi.fn(() => ({ users: { remove: vi.fn(async () => ({})) } })) },
      },
    })),
  },
};

const mockClient = {
  on: vi.fn(),
  login: vi.fn(async () => {}),
  destroy: vi.fn(),
  channels: {
    cache: {
      get: vi.fn(() => mockChannel),
    },
  },
  user: { id: 'bot-user' },
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
  ButtonStyle: { Success: 3, Danger: 4, Primary: 1 },
  ChannelType: { GuildText: 0, DM: 1, GroupDM: 3 },
  MessageFlags: { IsVoiceMessage: 1 << 30 },
  DiscordAPIError: class DiscordAPIError extends Error {},
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
    transport: new DiscordTransport(mockClient as unknown as DiscordLike, 'test-token'),
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

/** Invoke the transport's registered MessageCreate listener — exercises
 * normalization, the bot-author filter, and the error boundary. */
const dcMessage = async (_bot: unknown, payload: unknown): Promise<void> => {
  const calls = mockClient.on.mock.calls.filter((c) => c[0] === 'messageCreate');
  const listener = calls[calls.length - 1]?.[1] as (m: unknown) => Promise<void>;
  await listener?.(payload);
};

/** Invoke the transport's registered InteractionCreate listener. */
const dcInteraction = async (_bot: unknown, payload: unknown): Promise<void> => {
  const calls = mockClient.on.mock.calls.filter((c) => c[0] === 'interactionCreate');
  const listener = calls[calls.length - 1]?.[1] as (i: unknown) => Promise<void>;
  await listener?.(payload);
};

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
    await dcMessage(bot, makeMessage('999', 'hello'));
    expect(mockChannel.send).not.toHaveBeenCalledWith('hello');
  });

  it('responds with channel ID in setup mode (empty allowlist)', async () => {
    const { bot } = createBot({ allowedChannelIds: [] });
    await bot.start();
    await dcMessage(bot, makeMessage('999', 'hello'));
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Your channel ID is: 999') })
    );
  });

  it('ignores bot messages', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, makeMessage('123', 'hello', true));
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('forwards allowed messages to ACP', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, makeMessage('123', 'hello agent'));
    expect(acp.prompt).toHaveBeenCalledWith('hello agent');
  });

  it('prefixes guild messages with [Discord/Channel] Sender:', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, {
      author: { bot: false, displayName: 'Santi', username: 'santi' },
      channel: { id: '123', type: 0, name: 'general', send: mockChannel.send },
      content: 'hola',
    } as unknown as MockMessage);
    expect(acp.prompt).toHaveBeenCalledWith('[Discord/general] Santi: hola');
  });

  it('prefixes DM messages with [Discord] Sender:', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, {
      author: { bot: false, displayName: 'Germán', username: 'german' },
      channel: { id: '123', type: 1, send: mockChannel.send },
      content: 'hola',
    } as unknown as MockMessage);
    expect(acp.prompt).toHaveBeenCalledWith('[Discord] Germán: hola');
  });

  it('handles /start and /help commands', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, makeMessage('123', '/help'));
    expect(acp.prompt).not.toHaveBeenCalled();
    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('acp-connector') })
    );
  });

  it('ignores empty text', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, makeMessage('123', ''));
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

    await dcMessage(bot, makeMessage('123', 'hi'));

    // Flush stream timer
    await vi.advanceTimersByTimeAsync(800);
    await vi.runAllTimersAsync();

    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Hello world') })
    );
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

    await dcMessage(bot, makeMessage('123', 'hi'));

    expect(acp.prompt).toHaveBeenCalledWith('hi');
  });

  it('sends error message on prompt failure', async () => {
    const { bot, acp } = createBot();
    acp.prompt = vi.fn(() => {
      throw new Error('agent crashed');
    });
    await bot.start();

    await dcMessage(bot, makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Error: agent crashed') })
      );
    });
  });

  it('sends error message when acp.prompt() rejects asynchronously', async () => {
    const { bot, acp } = createBot();
    acp.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    await bot.start();

    await dcMessage(bot, makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Error: prompt failed') })
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

    await dcMessage(bot, makeMessage('123', 'hi'));

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

    await dcMessage(bot, makeMessage('123', 'hi'));

    // Should not have sent 'thinking' — only empty or nothing
    const calls = mockChannel.send.mock.calls;
    for (const call of calls) {
      expect(String(call[0]?.content ?? call[0])).not.toContain('thinking');
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

    await dcMessage(bot, makeMessage('123', 'hi'));

    await vi.advanceTimersByTimeAsync(800);
    await vi.runAllTimersAsync();

    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('thinking') })
    );
  });

  it('sends stop reason when response is empty', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate = vi.fn(async () => ({ kind: 'stop', stopReason: 'max_tokens' }));

    await dcMessage(bot, makeMessage('123', 'hi'));

    await vi.waitFor(() => {
      expect(mockChannel.send).toHaveBeenCalledWith({ content: '[max_tokens]' });
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
    await dcMessage(bot, makeMessage('123', '/custom'));
    expect(onCommand).toHaveBeenCalledWith('/custom', '123');
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('/stop when idle responds nothing to stop', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    await dcMessage(bot, makeMessage('123', '/stop'));
    expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Nothing to stop.' });
    expect(acp.cancel).not.toHaveBeenCalled();
  });

  it('/stop when busy cancels the agent', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    await dcMessage(bot, makeMessage('123', 'long task'));
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await dcMessage(bot, makeMessage('123', '/stop'));
    expect(acp.cancel).toHaveBeenCalled();
    expect(mockChannel.send).toHaveBeenCalledWith({ content: '⏹ Stopped.' });
  });

  it('/stop clears the queue', async () => {
    const { bot, acp } = createBot();
    await bot.start();
    acp.nextUpdate.mockReturnValue(new Promise(() => {}));
    await dcMessage(bot, makeMessage('123', 'first'));
    await vi.waitFor(() => expect(bot.busy).toBe(true));
    await dcMessage(bot, makeMessage('123', 'second'));
    await dcMessage(bot, makeMessage('123', 'third'));
    expect(bot.queue.length).toBe(2);
    await dcMessage(bot, makeMessage('123', '/stop'));
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
    const interaction = makeInteraction({
      channel: { id: '123', type: 0 },
      user: { id: 'u2' },
    });
    await dcInteraction(bot, interaction);
    expect(resolve).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it('denies guild interactions when allowedUserIds is empty', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const interaction = makeInteraction({ channel: { id: '123', type: 0 } });
    await dcInteraction(bot, interaction);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows permission interactions from allowlisted users in guilds', async () => {
    const { bot } = createBot({ allowedUserIds: ['u1'] });
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const interaction = makeInteraction({ channel: { id: '123', type: 0 } });
    await dcInteraction(bot, interaction);
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
    await dcInteraction(bot, makeInteraction());
    expect(resolve).toHaveBeenCalled();
  });

  it('rejects permission interactions from a stale message', async () => {
    const { bot } = createBot();
    await bot.start();
    const resolve = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: protected member under test
    (bot as any).permissionPending = { resolve, messageId: 'm1' };
    const interaction = makeInteraction({ message: { id: 'old-msg' } });
    await dcInteraction(bot, interaction);
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
    await dcMessage(bot, makeMessage('123', '/sessions'));
    const report = mockChannel.send.mock.calls.find(
      (c) => typeof c[0]?.content === 'string' && c[0].content.includes('⚠️')
    );
    expect(report).toBeDefined();
  });

  it('transcribes voice messages (IsVoiceMessage) into a text block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new TextEncoder().encode('fake-ogg').buffer,
      }))
    );
    const { MediaHandler } = await import('../src/media.ts');
    const transcriber = { transcribe: vi.fn(async () => 'discord voice transcript') };
    const mediaHandler = new MediaHandler({
      uploadsDir: '/tmp/test-dc-voice-uploads',
      supportsImage: true,
      transcriber,
      deleteAfterTranscribe: true,
    });
    const { bot, acp } = createBot({ mediaHandler });
    await bot.start();
    const attachments = new Map([
      ['a1', { contentType: 'audio/ogg', name: 'voice.ogg', url: 'https://cdn.example/v.ogg' }],
    ]);
    await dcMessage(bot, {
      ...makeMessage('123', ''),
      id: 'm-voice',
      flags: { has: (f: number) => f === 1 << 30 },
      attachments,
    });
    await vi.waitFor(() => expect(acp.prompt).toHaveBeenCalled());
    const promptArg = acp.prompt.mock.calls[0][0];
    expect(promptArg[0]).toMatchObject({ type: 'text', text: 'discord voice transcript' });
    expect(transcriber.transcribe).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
