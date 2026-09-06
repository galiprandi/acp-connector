import { vi } from 'vitest';

/**
 * Create a mock ACP session.
 * @returns {Object}
 */
export function createMockSession() {
  const updates = [];
  return {
    sessionId: 'test-session-id',
    modes: { currentModeId: 'default' },
    prompt: vi.fn(async () => {}),
    nextUpdate: vi.fn(async () => {
      if (updates.length > 0) return updates.shift();
      return { kind: 'stop', stopReason: 'end_turn' };
    }),
    dispose: vi.fn(),
    _pushUpdate: (update) => updates.push(update),
  };
}

/**
 * Create a mock ACP client context.
 * @param {Object} session
 * @param {Object} [initResult]
 * @returns {Object}
 */
export function createMockCtx(session, initResult = {}) {
  return {
    request: vi.fn(async (method, _params) => {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, ...initResult.agentCapabilities },
          ...initResult,
        };
      }
      if (method === 'session/load' || method === 'session/resume') {
        return {};
      }
      return {};
    }),
    buildSession: vi.fn(() => ({
      start: vi.fn(async () => session),
    })),
    attachSession: vi.fn(() => session),
  };
}

/**
 * Create a mock for the @agentclientprotocol/sdk module.
 * @param {Object} session
 * @param {Object} [initResult]
 * @returns {Object}
 */
export function createMockAcpSdk(session, initResult = {}) {
  const ctx = createMockCtx(session, initResult);
  const clientInstance = {
    onRequest: vi.fn(() => clientInstance),
    connectWith: vi.fn(async (_stream, callback) => {
      await callback(ctx);
      return clientInstance;
    }),
    catch: vi.fn(() => clientInstance),
  };

  return {
    client: vi.fn(() => clientInstance),
    ndJsonStream: vi.fn(() => ({ readable: true, writable: true })),
    PROTOCOL_VERSION: 1,
    methods: {
      agent: {
        initialize: 'initialize',
        session: {
          load: 'session/load',
          resume: 'session/resume',
        },
      },
      client: {
        session: {
          requestPermission: 'session/request_permission',
        },
      },
    },
    _ctx: ctx,
    _clientInstance: clientInstance,
  };
}
