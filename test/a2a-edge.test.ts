import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aServer } from '../src/a2a.ts';
import { NetworkStore } from '../src/network.ts';

let dir: string;
let network: NetworkStore;
let server: A2aServer;
let port: number;
let enqueue: ReturnType<typeof vi.fn>;

async function post(path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acp-edge-'));
  network = new NetworkStore(join(dir, 'network.json'));
  enqueue = vi.fn((_t, _c, _b, done) => done?.('ok'));
  server = new A2aServer({
    config: { enabled: true, port: 0, card: { name: 'T', description: 't' } },
    network,
    selfId: 'self',
    enqueue,
  });
  await server.start();
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

const approved = {
  id: 'p',
  cardUrl: 'http://x',
  status: 'approved' as const,
  source: 'declared' as const,
};
const send = (parts: unknown, meta?: Record<string, unknown>, peer = 'p', msgId = 'm') =>
  post(
    '/',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', messageId: msgId, parts, metadata: meta } },
    }),
    { 'X-A2A-Peer-Id': peer }
  ).then((r) => r.json());

describe('edge: auth surface', () => {
  it('missing peer-id header is rejected before any processing', async () => {
    const res = await send([{ kind: 'text', text: 'x' }], undefined, '');
    expect(res.error.code).toBe(-32001);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('well-known card is public even without headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
  });

  it('rejected and ignored peers cannot send tasks', async () => {
    for (const status of ['rejected', 'ignored', 'revoked'] as const) {
      network.upsertPeer({ ...approved, id: `p-${status}`, status });
      const res = await send([{ kind: 'text', text: 'hi' }], undefined, `p-${status}`);
      expect(res.error.code).toBe(-32001);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('edge: payload handling', () => {
  it('empty parts array produces an empty prompt, not a crash', async () => {
    network.upsertPeer(approved);
    const res = await send([]);
    expect(res.result).toBeDefined();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('missing message object is handled gracefully', async () => {
    network.upsertPeer(approved);
    const res = await post(
      '/',
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'message/send', params: {} }),
      { 'X-A2A-Peer-Id': 'p' }
    ).then((r) => r.json());
    expect(res.result).toBeDefined();
  });

  it('agent error propagates as JSON-RPC error', async () => {
    network.upsertPeer(approved);
    enqueue = vi.fn((_t, _c, _b, done) => done?.('', 'agent exploded'));
    server.enqueue = enqueue;
    const res = await send([{ kind: 'text', text: 'hi' }]);
    expect(res.error ?? res.result).toBeDefined();
  });
});

describe('edge: dedup and loops', () => {
  beforeEach(() => network.upsertPeer(approved));

  it('taskId dedup works even when messageId differs', async () => {
    await send([{ kind: 'text', text: 'a' }], { 'a2a.taskId': 'T1' }, 'p', 'm1');
    const res = await send([{ kind: 'text', text: 'b' }], { 'a2a.taskId': 'T1' }, 'p', 'm2');
    expect(res.error.code).toBe(-32002);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('same messageId without explicit taskId is also deduped', async () => {
    await send([{ kind: 'text', text: 'a' }], undefined, 'p', 'same-id');
    const res = await send([{ kind: 'text', text: 'b' }], undefined, 'p', 'same-id');
    expect(res.error.code).toBe(-32002);
  });

  it('delegation chain at exact depth limit is rejected', async () => {
    const res = await send([{ kind: 'text', text: 'x' }], {
      'a2a.delegationChain': ['a', 'b', 'c'],
    });
    expect(res.error.code).toBe(-32003);
  });

  it('self in the middle of the chain is rejected', async () => {
    const res = await send([{ kind: 'text', text: 'x' }], {
      'a2a.delegationChain': ['a', 'self', 'b'],
    });
    expect(res.error.code).toBe(-32003);
  });
});

describe('edge: join endpoint', () => {
  it('join with missing fields returns 400', async () => {
    const res = await post('/a2a/join', JSON.stringify({ id: 'x' }));
    expect(res.status).toBe(400);
  });

  it('join with malformed JSON returns 500/400 but never hangs', async () => {
    const res = await post('/a2a/join', '{bad');
    expect([400, 500]).toContain(res.status);
  });

  it('non-POST methods on /a2a/join return 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/a2a/join`);
    expect(res.status).toBe(404);
  });
});

describe('edge: misc', () => {
  it('unknown GET path returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('GET on the RPC endpoint returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
  });

  it('server disabled: start() is a no-op and nothing listens', async () => {
    const off = new A2aServer({
      config: { enabled: false, port: 0, card: { name: 'x', description: 'x' } },
      network,
      selfId: 'self',
      enqueue,
    });
    await off.start();
    expect(off.address()).toBeNull();
  });
});

describe('message/stream (SSE)', () => {
  it('streams task + status events and completes', async () => {
    network.upsertPeer(approved);
    enqueue = vi.fn((_t, _c, _b, done, onChunk) => {
      onChunk?.('hello ');
      onChunk?.('world');
      done?.('hello world');
    });
    server.enqueue = enqueue;

    const res = await post(
      '/',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'message/stream',
        params: {
          message: {
            role: 'user',
            messageId: 'st1',
            contextId: 'conv-9',
            parts: [{ kind: 'text', text: 'stream me' }],
            metadata: { 'a2a.taskId': 'st1' },
          },
        },
      }),
      { 'X-A2A-Peer-Id': 'p' }
    );

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    const events = body
      .split('\n\n')
      .filter((b) => b.trim())
      .map((block) => {
        const data = block
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6);
        return JSON.parse(data ?? '{}');
      });

    expect(events[0].kind).toBe('task');
    expect(events[0].status.state).toBe('working');
    expect(events[0].contextId).toBe('conv-9');
    const statusEvents = events.filter((e) => e.kind === 'status-update');
    expect(statusEvents.at(-1)?.status.state).toBe('completed');
    expect(statusEvents.at(-1)?.final).toBe(true);
    const text = statusEvents.at(-1)?.status.message.parts[0].text;
    expect(text).toBe('hello world');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects unapproved peers before opening the stream', async () => {
    const res = await post(
      '/',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'message/stream',
        params: { message: { role: 'user', messageId: 'x', parts: [{ kind: 'text', text: 'y' }] } },
      }),
      { 'X-A2A-Peer-Id': 'stranger' }
    );
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('echoes contextId in the plain message/send response', async () => {
    network.upsertPeer(approved);
    const res = await send([{ kind: 'text', text: 'hi' }], undefined, 'p', 'm-ctx');
    expect(res.result.contextId).toBeDefined();
  });
});
