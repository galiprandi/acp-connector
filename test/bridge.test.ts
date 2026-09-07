import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config';
import type { CronManagerOptions } from '../src/cron';

const validConfig: BridgeConfig = {
  agentCmd: 'acp-agent serve',
  platforms: {
    telegram: {
      token: 'test-token',
      allowedChatIds: [123],
    },
  },
};

let mockConfig: BridgeConfig | null = null;

vi.mock('../src/config.ts', () => ({
  loadConfig: () => mockConfig,
}));

interface MockAcpClient {
  start: vi.Mock;
  kill: vi.Mock;
  prompt: vi.Mock;
  nextUpdate: vi.Mock;
  sessionId: string;
  modes: { currentModeId: string };
  session: Record<string, unknown>;
  onPermission: ((params: unknown) => Promise<unknown>) | null;
}

// Mock all modules
const mockAcpClient: MockAcpClient = {
  start: vi.fn(async () => {}),
  kill: vi.fn(),
  prompt: vi.fn(async () => {}),
  nextUpdate: vi.fn(),
  sessionId: 'test-session',
  modes: { currentModeId: 'default' },
  session: {},
  onPermission: null,
};

interface MockBot {
  start: vi.Mock;
  stop: vi.Mock;
  enqueuePrompt: vi.Mock;
  sendMessage: vi.Mock;
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
  hasActivePrompt: vi.Mock;
  setMediaHandler: vi.Mock;
  setCommandHandler: vi.Mock;
  _handlePermission: vi.Mock;
}

const mockBot: MockBot = {
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  enqueuePrompt: vi.fn(),
  sendMessage: vi.fn(async () => ({})),
  onCommand: null,
  hasActivePrompt: vi.fn(() => false),
  setMediaHandler: vi.fn(),
  setCommandHandler: vi.fn(),
  _handlePermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' } })),
};

const mockDiscordBot: MockBot = {
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  enqueuePrompt: vi.fn(),
  sendMessage: vi.fn(async () => ({})),
  onCommand: null,
  hasActivePrompt: vi.fn(() => false),
  setMediaHandler: vi.fn(),
  setCommandHandler: vi.fn(),
  _handlePermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' } })),
};

let lastCronManagerArgs: CronManagerOptions | null = null;

interface MockCronManager {
  start: vi.Mock;
  stop: vi.Mock;
  list: vi.Mock;
  add: vi.Mock;
  remove: vi.Mock;
  toggle: vi.Mock;
  run: vi.Mock;
}

const mockCronManager: MockCronManager = {
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn(() => []),
  add: vi.fn(),
  remove: vi.fn(),
  toggle: vi.fn(),
  run: vi.fn(),
};

interface MockRoutineManager {
  handleCommand: vi.Mock;
}

const mockRoutineManager: MockRoutineManager = {
  handleCommand: vi.fn(async () => false),
};

interface MockHttpServer {
  start: vi.Mock;
  stop: vi.Mock;
}

const mockHttpServer: MockHttpServer = {
  start: vi.fn(),
  stop: vi.fn(),
};

interface MockAcpInstance {
  onPermission: ((params: unknown) => Promise<unknown>) | null;
}

interface MockBotInstance {
  onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null;
}

let lastAcpInstance: MockAcpInstance | null = null;
let lastBotInstance: MockBotInstance | null = null;

vi.mock('../src/acp-client.ts', () => ({
  AcpClient: class MockAcpClient {
    start = mockAcpClient.start;
    kill = mockAcpClient.kill;
    prompt = mockAcpClient.prompt;
    nextUpdate = mockAcpClient.nextUpdate;
    sessionId = mockAcpClient.sessionId;
    modes = mockAcpClient.modes;
    session = mockAcpClient.session;
    onPermission: ((params: unknown) => Promise<unknown>) | null = null;
    constructor() {
      lastAcpInstance = this as unknown as MockAcpInstance;
    }
  },
}));
vi.mock('../src/bot.ts', () => ({
  BridgeBot: class MockBridgeBot {
    start = mockBot.start;
    stop = mockBot.stop;
    enqueuePrompt = mockBot.enqueuePrompt;
    sendMessage = mockBot.sendMessage;
    onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null = null;
    hasActivePrompt = mockBot.hasActivePrompt;
    setMediaHandler = mockBot.setMediaHandler;
    setCommandHandler(fn: (text: string, chatId: number | string) => Promise<boolean>): void {
      this.onCommand = fn;
      mockBot.setCommandHandler(fn);
    }
    _handlePermission = mockBot._handlePermission;
    constructor() {
      lastBotInstance = this as unknown as MockBotInstance;
    }
  },
}));
vi.mock('../src/discord.ts', () => ({
  DiscordBot: class MockDiscordBot {
    start = mockDiscordBot.start;
    stop = mockDiscordBot.stop;
    enqueuePrompt = mockDiscordBot.enqueuePrompt;
    sendMessage = mockDiscordBot.sendMessage;
    onCommand: ((text: string, chatId: number | string) => Promise<boolean>) | null = null;
    hasActivePrompt = mockDiscordBot.hasActivePrompt;
    setMediaHandler = mockDiscordBot.setMediaHandler;
    setCommandHandler(fn: (text: string, chatId: number | string) => Promise<boolean>): void {
      this.onCommand = fn;
      mockDiscordBot.setCommandHandler(fn);
    }
    _handlePermission = mockDiscordBot._handlePermission;
    constructor() {
      lastBotInstance = this as unknown as MockBotInstance;
    }
  },
}));
vi.mock('../src/cron.ts', () => ({
  CronManager: class MockCronManager {
    start = mockCronManager.start;
    stop = mockCronManager.stop;
    list = mockCronManager.list;
    add = mockCronManager.add;
    remove = mockCronManager.remove;
    toggle = mockCronManager.toggle;
    run = mockCronManager.run;
    constructor(args: CronManagerOptions) {
      lastCronManagerArgs = args;
    }
  },
}));
vi.mock('../src/routines.ts', () => ({
  RoutineManager: class MockRoutineManager {
    handleCommand = mockRoutineManager.handleCommand;
  },
}));
vi.mock('../src/http.js', () => ({
  HttpServer: class MockHttpServer {
    start = mockHttpServer.start;
    stop = mockHttpServer.stop;
  },
}));

const { run } = await import('../src/bridge.js');

describe('bridge', () => {
  let intervalSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAcpClient.start.mockResolvedValue(undefined);
    mockConfig = null;
    lastCronManagerArgs = null;
    intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(() => 0);
    onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
  });

  afterEach(() => {
    intervalSpy.mockRestore();
    onSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when no config found', async () => {
    mockConfig = null;
    await expect(run()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('starts ACP, bot, cron, and HTTP', async () => {
    mockConfig = { ...validConfig };
    await run();
    expect(mockAcpClient.start).toHaveBeenCalled();
    expect(mockBot.start).toHaveBeenCalled();
    expect(mockCronManager.start).toHaveBeenCalled();
    expect(mockHttpServer.start).toHaveBeenCalled();
  });

  it('exits with error when ACP fails to start', async () => {
    mockConfig = { ...validConfig };
    mockAcpClient.start.mockRejectedValueOnce(new Error('agent crashed'));
    await expect(run()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('wires onCommand to routine manager', async () => {
    mockConfig = { ...validConfig };
    await run();
    expect(lastBotInstance?.onCommand).toBeDefined();
    expect(typeof lastBotInstance?.onCommand).toBe('function');
  });

  it('wires onPermission to bot', async () => {
    mockConfig = { ...validConfig };
    await run();
    expect(lastAcpInstance?.onPermission).toBeDefined();
    expect(typeof lastAcpInstance?.onPermission).toBe('function');
  });

  it('preserves Discord Snowflake channel IDs for cron allowedChatIds', async () => {
    const snowflake: string = '123456789012345678';
    mockConfig = {
      agentCmd: 'acp-agent serve',
      platforms: {
        discord: {
          token: 'discord-token',
          allowedChannelIds: [snowflake],
        },
      },
    };
    await run();
    expect(lastCronManagerArgs).not.toBeNull();
    expect(lastCronManagerArgs?.allowedChatIds).toContain(snowflake);
  });

  it('routes permission to the bot with an active prompt (Discord), not the first bot (TG)', async () => {
    mockConfig = {
      agentCmd: 'acp-agent serve',
      platforms: {
        telegram: { token: 'tg-token', allowedChatIds: [123] },
        discord: { token: 'dc-token', allowedChannelIds: ['999'] },
      },
    };
    await run();
    // Simulate Discord having an active prompt, TG idle
    mockBot.hasActivePrompt.mockReturnValue(false);
    mockDiscordBot.hasActivePrompt.mockReturnValue(true);
    mockBot._handlePermission.mockClear();
    mockDiscordBot._handlePermission.mockClear();

    await lastAcpInstance?.onPermission?.({ options: [{ kind: 'allow', optionId: 'a1' }] });

    expect(mockDiscordBot._handlePermission).toHaveBeenCalledTimes(1);
    expect(mockBot._handlePermission).not.toHaveBeenCalled();
  });
});
