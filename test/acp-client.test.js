import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK before importing AcpClient
const mockSession = {
  sessionId: 'test-session-id',
  modes: { currentModeId: 'default' },
  prompt: vi.fn(async () => {}),
  nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
  dispose: vi.fn(),
};

const mockCtx = {
  request: vi.fn(async (method) => {
    if (method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      };
    }
    return {};
  }),
  buildSession: vi.fn(() => ({
    start: vi.fn(async () => mockSession),
  })),
  attachSession: vi.fn(() => mockSession),
};

const mockClientInstance = {
  onRequest: vi.fn(() => mockClientInstance),
  connectWith: vi.fn(async (_stream, callback) => {
    await callback(mockCtx);
    return mockClientInstance;
  }),
  catch: vi.fn(() => mockClientInstance),
};

vi.mock('@agentclientprotocol/sdk', () => ({
  client: vi.fn(() => mockClientInstance),
  ndJsonStream: vi.fn(() => ({ readable: true, writable: true })),
  PROTOCOL_VERSION: 1,
  methods: {
    agent: {
      initialize: 'initialize',
      session: { load: 'session/load', resume: 'session/resume' },
    },
    client: { session: { requestPermission: 'session/request_permission' } },
  },
}));

// Mock child_process.spawn
const mockProc = {
  stdin: { write: vi.fn(), end: vi.fn() },
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

// Mock stream conversions
vi.mock('node:stream', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Writable: { toWeb: vi.fn(() => ({})) },
    Readable: { toWeb: vi.fn(() => ({})) },
  };
});

const { AcpClient } = await import('../src/acp-client.js');

const tmpSessionConfig = resolve(process.cwd(), 'test-session.jsonc');

describe('AcpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx.request.mockImplementation(async (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      }
      return {};
    });
  });

  afterEach(() => {
    try {
      rmSync(tmpSessionConfig);
    } catch {
      // ignore
    }
  });

  it('creates a new session when no sessionId provided', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp' });
    await client.start();
    expect(mockCtx.buildSession).toHaveBeenCalled();
    expect(mockCtx.request).not.toHaveBeenCalledWith('session/load', expect.anything());
    expect(client.sessionId).toBe('test-session-id');
  });

  it('calls session/load when sessionId provided and loadSession capability is true', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp', sessionId: 'existing-session' });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ sessionId: 'existing-session' })
    );
    expect(mockCtx.attachSession).toHaveBeenCalled();
  });

  it('calls session/resume when resume capability is available', async () => {
    mockCtx.request.mockImplementation(async (method) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
          },
        };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'devin acp', sessionId: 'existing-session' });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({ sessionId: 'existing-session' })
    );
  });

  it('throws when no load/resume capability and sessionId provided', async () => {
    mockCtx.request.mockImplementation(async (method) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: {} };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'devin acp', sessionId: 'existing-session' });
    await expect(client.start()).rejects.toThrow('does not support session/resume or session/load');
  });

  it('auto-approves permission when no onPermission callback', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp' });
    const result = await client._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('opt1');
  });

  it('delegates permission to onPermission callback', async () => {
    const onPermission = vi.fn(async () => ({ outcome: { outcome: 'cancelled' } }));
    const client = new AcpClient({ agentCmd: 'devin acp', onPermission });
    const result = await client._handlePermission({ options: [] });
    expect(onPermission).toHaveBeenCalled();
    expect(result.outcome.outcome).toBe('cancelled');
  });

  it('kill() disposes session and kills process', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp' });
    await client.start();
    client.kill();
    expect(mockSession.dispose).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it('prompt() delegates to session.prompt', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp' });
    await client.start();
    await client.prompt('hello');
    expect(mockSession.prompt).toHaveBeenCalledWith('hello');
  });

  it('nextUpdate() delegates to session.nextUpdate', async () => {
    const client = new AcpClient({ agentCmd: 'devin acp' });
    await client.start();
    await client.nextUpdate();
    expect(mockSession.nextUpdate).toHaveBeenCalled();
  });

  it('loads session config from sessionConfigPath', async () => {
    writeFileSync(tmpSessionConfig, '{"cwd": "/tmp", "mcpServers": []}');
    const client = new AcpClient({
      agentCmd: 'devin acp',
      sessionConfigPath: tmpSessionConfig,
      sessionId: 'existing-session',
    });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ cwd: '/tmp', mcpServers: [] })
    );
  });
});
