import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validConfig = {
  agentCmd: 'acp-agent serve',
  telegramToken: 'test-token',
  allowedChatIds: [123],
};

let mockConfig = null;

vi.mock('../src/config.js', () => ({
  loadConfig: () => mockConfig,
}));

// Mock all modules
const mockAcpClient = {
  start: vi.fn(async () => {}),
  kill: vi.fn(),
  prompt: vi.fn(async () => {}),
  nextUpdate: vi.fn(),
  sessionId: 'test-session',
  modes: { currentModeId: 'default' },
  session: {},
  onPermission: null,
};

const mockBot = {
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  enqueuePrompt: vi.fn(),
  sendMessage: vi.fn(async () => ({})),
  onCommand: null,
  _handlePermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' } })),
};

const mockCronManager = {
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn(() => []),
  add: vi.fn(),
  remove: vi.fn(),
  toggle: vi.fn(),
  run: vi.fn(),
};

const mockRoutineManager = {
  handleCommand: vi.fn(async () => false),
};

const mockHttpServer = {
  start: vi.fn(),
  stop: vi.fn(),
};

let lastAcpInstance = null;
let lastBotInstance = null;

vi.mock('../src/acp-client.ts', () => ({
  AcpClient: class MockAcpClient {
    start = mockAcpClient.start;
    kill = mockAcpClient.kill;
    prompt = mockAcpClient.prompt;
    nextUpdate = mockAcpClient.nextUpdate;
    sessionId = mockAcpClient.sessionId;
    modes = mockAcpClient.modes;
    session = mockAcpClient.session;
    onPermission = null;
    constructor() {
      lastAcpInstance = this;
    }
  },
}));
vi.mock('../src/bot.ts', () => ({
  BridgeBot: class MockBridgeBot {
    start = mockBot.start;
    stop = mockBot.stop;
    enqueuePrompt = mockBot.enqueuePrompt;
    sendMessage = mockBot.sendMessage;
    onCommand = null;
    _handlePermission = mockBot._handlePermission;
    constructor() {
      lastBotInstance = this;
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
  let intervalSpy;
  let onSpy;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAcpClient.start.mockResolvedValue(undefined);
    mockConfig = null;
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
    expect(lastBotInstance.onCommand).toBeDefined();
    expect(typeof lastBotInstance.onCommand).toBe('function');
  });

  it('wires onPermission to bot', async () => {
    mockConfig = { ...validConfig };
    await run();
    expect(lastAcpInstance.onPermission).toBeDefined();
    expect(typeof lastAcpInstance.onPermission).toBe('function');
  });
});
