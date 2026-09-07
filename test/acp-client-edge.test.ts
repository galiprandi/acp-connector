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

interface MockProc {
  stdin: { write: vi.Mock; end: vi.Mock };
  stdout: { on: vi.Mock };
  stderr: { on: vi.Mock };
  on: vi.Mock;
  kill: vi.Mock;
}

// --- Mocks (same patterns as test/acp-client.test.js) -----------------------

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
      return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
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
        setMode: 'session/set_mode',
      },
    },
    client: { session: { requestPermission: 'session/request_permission' } },
  },
}));

// Mock child_process.spawn — default returns a healthy proc
const mockProc: MockProc = {
  stdin: { write: vi.fn(), end: vi.fn() },
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
};

const spawnMock = vi.fn(() => mockProc);

vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args: unknown[]) => spawnMock(...args)),
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

// --- Tests ------------------------------------------------------------------

describe('AcpClient edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue(mockProc);
    mockProc.on.mockClear();
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      }
      return {};
    });
    mockClientInstance.connectWith.mockImplementation(
      async (_stream: unknown, callback: (ctx: MockCtx) => Promise<void>) => {
        await callback(mockCtx);
        return mockClientInstance;
      }
    );
    mockSession.nextUpdate.mockResolvedValue({ kind: 'stop', stopReason: 'end_turn' });
    mockSession.prompt.mockResolvedValue(undefined);
    mockSession.dispose.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Agent spawn failure (command not found)
  it('rejects start() when the child process emits an error (command not found)', async () => {
    const procError = new Error('spawn acp-nonexistent ENOENT');
    const errorProc: MockProc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        if (event === 'error') {
          // Defer so listeners attach first
          setImmediate(() => cb(procError));
        }
      }),
      kill: vi.fn(),
    };
    spawnMock.mockReturnValueOnce(errorProc);
    // connectWith must NOT call the callback — a failed spawn never initializes
    mockClientInstance.connectWith.mockImplementationOnce(async () => mockClientInstance);

    const client = new AcpClient({ agentCmd: 'acp-nonexistent serve' });
    await expect(client.start()).rejects.toThrow('spawn acp-nonexistent ENOENT');
  });

  // 2. Session load failure (session/load throws)
  it('rejects start() when session/load throws', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      }
      if (method === 'session/load') {
        throw new Error('session not found');
      }
      return {};
    });

    const client = new AcpClient({ agentCmd: 'acp-agent serve', sessionId: 'missing' });
    await expect(client.start()).rejects.toThrow('session not found');
  });

  // 3. Session resume failure (session/resume throws)
  it('rejects start() when session/resume throws', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        };
      }
      if (method === 'session/resume') {
        throw new Error('resume failed');
      }
      return {};
    });

    const client = new AcpClient({ agentCmd: 'acp-agent serve', sessionId: 'missing' });
    await expect(client.start()).rejects.toThrow('resume failed');
  });

  // 4. Permission with no handler — default approve
  it('default-approves permission when no handler is set and allow option exists', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    const result = await client._handlePermission({
      options: [
        { kind: 'deny', optionId: 'deny1' },
        { kind: 'allow', optionId: 'allow1' },
      ],
    });
    expect(result.outcome.outcome).toBe('selected');
    expect(result.outcome.optionId).toBe('allow1');
  });

  // 5. Permission with handler that cancels
  it('delegates to onPermission handler that cancels', async () => {
    const onPermission = vi.fn(async () => ({ outcome: { outcome: 'cancelled' } }));
    const client = new AcpClient({ agentCmd: 'acp-agent serve', onPermission });
    const result = await client._handlePermission({
      options: [{ kind: 'allow', optionId: 'allow1' }],
    });
    expect(onPermission).toHaveBeenCalled();
    expect(result.outcome.outcome).toBe('cancelled');
  });

  // 6. nextUpdate after kill — should not hang or crash
  it('nextUpdate() after kill() does not hang or crash', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    client.kill();
    // After kill, session is disposed; nextUpdate should reject (not hang)
    mockSession.nextUpdate.mockRejectedValueOnce(new Error('session disposed'));
    await expect(client.nextUpdate()).rejects.toThrow('session disposed');
  });

  // 7. Double start — second start should be safe
  it('second start() is safe and does not spawn a second process', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    const firstProc = client.proc;
    await client.start();
    // Should reuse the same proc / session, not spawn again
    expect(client.proc).toBe(firstProc);
    expect(client.sessionId).toBe('test-session-id');
  });

  // 8. Double kill — second kill should be safe
  it('second kill() is safe and does not throw', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    client.kill();
    expect(() => client.kill()).not.toThrow();
    // dispose should only have been called once
    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
  });

  // 9. prompt() before start — should error or be safe
  it('prompt() before start() throws a clear error', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await expect(client.prompt('hello')).rejects.toThrow();
  });

  // 10. Empty prompt text
  it('prompt() forwards empty text to the session', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await client.prompt('');
    expect(mockSession.prompt).toHaveBeenCalledWith('');
  });

  // 11. Very long prompt text
  it('prompt() forwards very long text to the session', async () => {
    const longText: string = 'a'.repeat(1_000_000);
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    await client.prompt(longText);
    expect(mockSession.prompt).toHaveBeenCalledWith(longText);
  });

  // 12. Agent closes stdin unexpectedly
  it('handles agent closing stdin unexpectedly without crashing', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    // Simulate process exit (agent closed stdin / died)
    const exitHandler = mockProc.on.mock.calls.find((c: unknown[]) => c[0] === 'exit')?.[1];
    expect(exitHandler).toBeDefined();
    expect(() => (exitHandler as (code: number | null) => void)(0)).not.toThrow();
  });

  // 13. Permission with no options array
  it('default permission handling with no options array returns cancelled', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    const result = await client._handlePermission({});
    expect(result.outcome.outcome).toBe('cancelled');
  });

  // 14. Permission with options but no allow option
  it('default permission handling with options but no allow option returns cancelled', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    const result = await client._handlePermission({
      options: [{ kind: 'deny', optionId: 'deny1' }],
    });
    expect(result.outcome.outcome).toBe('cancelled');
  });

  // 15. newSession before start throws
  it('newSession before start throws', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await expect(client.newSession()).rejects.toThrow('ACP context not available');
  });

  // 16. listSessions before start throws
  it('listSessions before start throws', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await expect(client.listSessions()).rejects.toThrow('ACP context not available');
  });

  // 17. loadSession before start throws
  it('loadSession before start throws', async () => {
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await expect(client.loadSession('some-id')).rejects.toThrow('ACP context not available');
  });

  // 18. newSession with sessionConfig uses config-based builder
  it('newSession with sessionConfig uses config-based builder', async () => {
    const newSession: MockSession = {
      sessionId: 'fresh-session',
      modes: { currentModeId: 'default' },
      prompt: vi.fn(async () => {}),
      nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
      dispose: vi.fn(),
    };
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    mockCtx.buildSession.mockReturnValueOnce({
      start: vi.fn(async () => newSession),
    });
    const id = await client.newSession();
    expect(id).toBe('fresh-session');
    expect(client.sessionId).toBe('fresh-session');
  });

  // 19. loadSession disposes old session before switching
  it('loadSession disposes old session before switching', async () => {
    mockCtx.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        };
      }
      if (method === 'session/load') {
        return { sessionId: 'switched-session' };
      }
      return {};
    });
    const switchedSession: MockSession = {
      sessionId: 'switched-session',
      modes: { currentModeId: 'default' },
      prompt: vi.fn(async () => {}),
      nextUpdate: vi.fn(async () => ({ kind: 'stop', stopReason: 'end_turn' })),
      dispose: vi.fn(),
    };
    mockCtx.attachSession.mockReturnValueOnce(switchedSession);
    const client = new AcpClient({ agentCmd: 'acp-agent serve' });
    await client.start();
    // mockSession is the original session — should be disposed
    await client.loadSession('switched-session');
    expect(mockSession.dispose).toHaveBeenCalled();
    expect(client.sessionId).toBe('switched-session');
  });
});
