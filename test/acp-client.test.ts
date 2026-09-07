import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockSession {
  sessionId: string;
  modes: { currentModeId: string };
  prompt: vi.Mock;
  nextUpdate: vi.Mock;
  dispose: vi.Mock;
}

interface MockCtx {
  request: vi.Mock;
  buildSession: vi.Mock;
  attachSession: vi.Mock;
}

interface MockClientInstance {
  onRequest: vi.Mock;
  connectWith: vi.Mock;
  catch: vi.Mock;
}

// Mock the SDK before importing AcpClient
const mockSession: MockSession = {
  sessionId: 'test-session-id',
  modes: { currentModeId: 'default' },
  prompt: vi.fn(async () => {}),
  nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
  dispose: vi.fn(),
};

const mockCtx: MockCtx = {
  request: vi.fn(async (method: string) => {
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

const mockClientInstance: MockClientInstance = {
  onRequest: vi.fn(() => mockClientInstance),
  connectWith: vi.fn(async (_stream: unknown, callback: (ctx: MockCtx) => Promise<void>) => {
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
      session: {
        load: 'session/load',
        resume: 'session/resume',
        new: 'session/new',
        list: 'session/list',
        cancel: 'session/cancel',
      },
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
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Writable: { toWeb: vi.fn(() => ({})) },
    Readable: { toWeb: vi.fn(() => ({})) },
  };
});

const { AcpClient } = await import('../src/acp-client.ts');

const tmpSessionConfig: string = resolve(process.cwd(), 'test-session.jsonc');

describe('AcpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCtx.request.mockImplementation(async (method: string) => {
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
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    expect(mockCtx.buildSession).toHaveBeenCalled();
    expect(mockCtx.request).not.toHaveBeenCalledWith('session/load', expect.anything());
    expect(client.sessionId).toBe('test-session-id');
  });

  it('calls session/load when sessionId provided and loadSession capability is true', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve', sessionId: 'existing-session' });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ sessionId: 'existing-session' })
    );
    expect(mockCtx.attachSession).toHaveBeenCalled();
  });

  it('calls session/resume when resume capability is available', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
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
    const client = new AcpClient({ agentCmd: 'acp-agent serve', sessionId: 'existing-session' });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({ sessionId: 'existing-session' })
    );
  });

  it('throws when no load/resume capability and sessionId provided', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: {} };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'acp-agent serve', sessionId: 'existing-session' });
    await expect(client.start()).rejects.toThrow('does not support session/resume or session/load');
  });

  it('auto-approves permission when no onPermission callback', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    const result = await client._handlePermission({
      options: [{ kind: 'allow', optionId: 'opt1' }],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('opt1');
  });

  it('delegates permission to onPermission callback', async () => {
    const onPermission = vi.fn(async () => ({ outcome: { outcome: 'cancelled' } }));
    const client = new AcpClient({ agentCmd: 'acp-agent serve', onPermission });
    const result = await client._handlePermission({ options: [] });
    expect(onPermission).toHaveBeenCalled();
    expect(result.outcome.outcome).toBe('cancelled');
  });

  it('kill() disposes session and kills process', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    client.kill();
    expect(mockSession.dispose).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it('prompt() delegates to session.prompt', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await client.prompt('hello');
    expect(mockSession.prompt).toHaveBeenCalledWith('hello');
  });

  it('nextUpdate() delegates to session.nextUpdate', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await client.nextUpdate();
    expect(mockSession.nextUpdate).toHaveBeenCalled();
  });

  it('loads session config from sessionConfigPath', async () => {
    writeFileSync(tmpSessionConfig, '{"cwd": "/tmp", "mcpServers": []}');
    const client = new AcpClient({
      agentCmd: 'acp-agent serve',
      sessionConfigPath: tmpSessionConfig,
      sessionId: 'existing-session',
    });
    await client.start();
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ cwd: '/tmp', mcpServers: [] })
    );
  });

  it('newSession creates a new session and updates sessionId', async () => {
    const newSession: MockSession = {
      sessionId: 'new-session-id',
      modes: { currentModeId: 'default' },
      prompt: vi.fn(async () => {}),
      nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
      dispose: vi.fn(),
    };
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    expect(client.sessionId).toBe('test-session-id');
    // Set up the mock AFTER start() consumed the first buildSession call
    mockCtx.buildSession.mockReturnValueOnce({
      start: vi.fn(async () => newSession),
    });
    const id = await client.newSession();
    expect(id).toBe('new-session-id');
    expect(client.sessionId).toBe('new-session-id');
    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('listSessions returns sessions when capability supported', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
        };
      }
      if (method === 'session/list') {
        return {
          sessions: [
            { sessionId: 's1', cwd: '/tmp', title: 'Session 1' },
            { sessionId: 's2', cwd: '/tmp', title: null },
          ],
        };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe('s1');
    expect(sessions[0].title).toBe('Session 1');
  });

  it('listSessions throws when capability not supported', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: {} };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await expect(client.listSessions()).rejects.toThrow('does not support session/list');
  });

  it('loadSession uses session/resume when resume capability is available', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
          },
        };
      }
      if (method === 'session/resume') {
        return { sessionId: 'target-session' };
      }
      return {};
    });
    const loadedSession: MockSession = {
      sessionId: 'target-session',
      modes: { currentModeId: 'default' },
      prompt: vi.fn(async () => {}),
      nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
      dispose: vi.fn(),
    };
    mockCtx.attachSession.mockReturnValueOnce(loadedSession);
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    const id = await client.loadSession('target-session');
    expect(id).toBe('target-session');
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({ sessionId: 'target-session' })
    );
    expect(client.sessionId).toBe('target-session');
  });

  it('loadSession uses session/load when only loadSession capability is true', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      }
      if (method === 'session/load') {
        return { sessionId: 'loaded-session' };
      }
      return {};
    });
    const loadedSession: MockSession = {
      sessionId: 'loaded-session',
      modes: { currentModeId: 'default' },
      prompt: vi.fn(async () => {}),
      nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
      dispose: vi.fn(),
    };
    mockCtx.attachSession.mockReturnValueOnce(loadedSession);
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    const id = await client.loadSession('loaded-session');
    expect(id).toBe('loaded-session');
    expect(mockCtx.request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ sessionId: 'loaded-session' })
    );
  });

  it('loadSession throws when no load/resume capability', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: {} };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await expect(client.loadSession('some-id')).rejects.toThrow(
      'does not support session/resume or session/load'
    );
  });

  it('stores agentCapabilities from init response', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {} },
          },
        };
      }
      return {};
    });
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    expect(client.agentCapabilities).toEqual({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
    });
  });
});
