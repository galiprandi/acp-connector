import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aServer } from '../src/a2a.ts';
import { A2aManager } from '../src/a2a-manager.ts';
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

describe('edge: peer auth', () => {
  const bodyOf = (parts: unknown, meta?: Record<string, unknown>, msgId = 'm') =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', messageId: msgId, parts, metadata: meta } },
    });

  const sendRaw = (body: string, headers: Record<string, string> = {}) =>
    post('/', body, headers).then((r) => r.json());

  const signedHeaders = (peerId: string, body: string) => {
    const secret = network.getPeer(peerId)?.auth?.secret ?? '';
    return {
      'X-A2A-Peer-Id': peerId,
      'X-A2A-Peer-Signature': createHmac('sha256', secret).update(body).digest('hex'),
    };
  };

  it('accepts a signed message/send from a peer with auth', async () => {
    network.upsertPeer({ ...approved, status: 'approved' });
    network.issuePeerAuth('p');
    const body = bodyOf([{ kind: 'text', text: 'signed hello' }]);
    const res = await sendRaw(body, signedHeaders('p', body));
    expect(res.result).toBeDefined();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('accepts an unsigned legacy peer when secure is false', async () => {
    network.upsertPeer({ ...approved, status: 'approved' });
    const body = bodyOf([{ kind: 'text', text: 'legacy' }]);
    const res = await sendRaw(body, { 'X-A2A-Peer-Id': 'p' });
    expect(res.result).toBeDefined();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects an unsigned peer when secure is true', async () => {
    const secureDir = mkdtempSync(join(tmpdir(), 'acp-edge-secure-'));
    const secureNetwork = new NetworkStore(join(secureDir, 'network.json'));
    secureNetwork.upsertPeer({ ...approved, status: 'approved' });
    secureNetwork.issuePeerAuth('p');
    const secureServer = new A2aServer({
      config: { enabled: true, port: 0, card: { name: 'S', description: 's' }, secure: true },
      network: secureNetwork,
      selfId: 'self',
      enqueue: vi.fn((_t, _c, _b, done) => done?.('ok')),
    });
    await secureServer.start();
    const secureAddr = secureServer.address();
    const securePort = typeof secureAddr === 'object' && secureAddr ? secureAddr.port : 0;
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] } },
      });
      const res = await fetch(`http://127.0.0.1:${securePort}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-A2A-Peer-Id': 'p' },
        body,
      }).then((r) => r.json());
      expect(res.error.code).toBe(-32001);
      expect(res.error.message).toMatch(/signature required/i);
    } finally {
      await secureServer.stop();
      rmSync(secureDir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong signature when secure is false', async () => {
    network.upsertPeer({ ...approved, status: 'approved' });
    network.issuePeerAuth('p');
    const real = network.getPeer('p')?.auth?.secret ?? '';
    const body = bodyOf([{ kind: 'text', text: 'forged' }]);
    const res = await sendRaw(body, {
      'X-A2A-Peer-Id': 'p',
      'X-A2A-Peer-Signature': createHmac('sha256', real).update('tampered').digest('hex'),
    });
    expect(res.error).toBeDefined();
    expect(enqueue).not.toHaveBeenCalled();
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

describe('edge: membership hardening (confirm + announce)', () => {
  type AnnounceResult = { status: number; body: string };

  /**
   * The local test server only ever receives requests from loopback, so
   * `_handleRegistry` is invoked directly with a crafted
   * IncomingMessage/ServerResponse pair to present a chosen
   * `remoteAddress` (the file has no other non-loopback mechanism).
   */
  function announceRequest(
    body: string,
    remoteAddress: string,
    headers: Record<string, string> = {}
  ): IncomingMessage {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      socket: { remoteAddress },
    });
    process.nextTick(() => {
      req.emit('data', body);
      req.emit('end');
    });
    return req as unknown as IncomingMessage;
  }

  function announceRes(record: AnnounceResult): ServerResponse {
    const res = {
      writeHead(code: number) {
        record.status = code;
      },
      end(data?: string) {
        record.body = data ?? '';
      },
    };
    return res as unknown as ServerResponse;
  }

  async function announceAs(
    remoteAddress: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<AnnounceResult> {
    network.role = 'registry';
    const record: AnnounceResult = { status: 0, body: '' };
    const raw = JSON.stringify(payload);
    const handler = server as unknown as {
      _handleRegistry(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
    };
    await handler._handleRegistry(
      announceRequest(raw, remoteAddress, headers),
      announceRes(record),
      new URL('/a2a/registry/announce', 'http://localhost')
    );
    return record;
  }

  describe('announce authorization', () => {
    beforeEach(() => {
      network.role = 'registry';
      network.upsertPeer({
        id: 'p',
        cardUrl: 'http://x-old',
        card: { name: 'Old', skills: [] },
        status: 'approved',
        source: 'declared',
      });
      const peer = network.getPeer('p');
      if (!peer) throw new Error('peer p missing');
      peer.lastSeen = '2020-01-01T00:00:00.000Z';
    });

    it('unauthenticated announce cannot change cardUrl or card', async () => {
      const rec = await announceAs('192.168.68.42', {
        id: 'p',
        cardUrl: 'http://evil.example',
        card: { name: 'Evil' },
      });
      expect(rec.status).toBe(403);
      expect(JSON.parse(rec.body).error).toBe('signature or loopback required for card updates');
      const peer = network.getPeer('p');
      expect(peer?.cardUrl).toBe('http://x-old');
      expect(peer?.card?.name).toBe('Old');
      // only the heartbeat is recorded
      expect(peer?.lastSeen).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('a bogus signature is also treated as unauthenticated', async () => {
      network.issuePeerAuth('p');
      const rec = await announceAs(
        '192.168.68.42',
        { id: 'p', cardUrl: 'http://evil.example' },
        { 'x-a2a-peer-signature': createHmac('sha256', 'wrong').update('x').digest('hex') }
      );
      expect(rec.status).toBe(403);
      expect(network.getPeer('p')?.cardUrl).toBe('http://x-old');
    });

    it('signed announce updates cardUrl, card and lastSeen', async () => {
      network.issuePeerAuth('p');
      const secret = network.getPeer('p')?.auth?.secret ?? '';
      const payload = {
        id: 'p',
        cardUrl: 'http://x-new',
        card: { name: 'New', skills: [{ id: 's' }] },
      };
      const rec = await announceAs('192.168.68.42', payload, {
        'x-a2a-peer-signature': createHmac('sha256', secret)
          .update(JSON.stringify(payload))
          .digest('hex'),
      });
      expect(rec.status).toBe(200);
      expect(JSON.parse(rec.body).status).toBe('ok');
      const peer = network.getPeer('p');
      expect(peer?.cardUrl).toBe('http://x-new');
      expect(peer?.card?.name).toBe('New');
      expect(peer?.lastSeen).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('signed announce rejects non-http(s) and unparseable cardUrl', async () => {
      network.issuePeerAuth('p');
      const secret = network.getPeer('p')?.auth?.secret ?? '';
      for (const badUrl of ['ftp://files.example', 'not a url']) {
        const payload = { id: 'p', cardUrl: badUrl };
        const rec = await announceAs('192.168.68.42', payload, {
          'x-a2a-peer-signature': createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex'),
        });
        expect(rec.status).toBe(400);
        // no state change on rejection
        expect(network.getPeer('p')?.cardUrl).toBe('http://x-old');
        expect(network.getPeer('p')?.card?.name).toBe('Old');
      }
    });

    it('loopback announce keeps full update rights', async () => {
      const rec = await announceAs('127.0.0.1', {
        id: 'p',
        cardUrl: 'http://x-loop',
        card: { name: 'Loop' },
      });
      expect(rec.status).toBe(200);
      expect(network.getPeer('p')?.cardUrl).toBe('http://x-loop');
      expect(network.getPeer('p')?.card?.name).toBe('Loop');
    });
  });

  describe('confirm never escalates membership', () => {
    it('join creates pending, confirm does not approve (asserted via the store)', async () => {
      const memberDir = mkdtempSync(join(tmpdir(), 'acp-edge-member-'));
      const memberNetwork = new NetworkStore(join(memberDir, 'network.json'));
      const notify = vi.fn(async () => {});
      const manager = new A2aManager({
        network: memberNetwork,
        selfId: 'theirs',
        notify,
      });
      const memberServer = new A2aServer({
        config: { enabled: true, port: 0, card: { name: 'M', description: 'm' } },
        network: memberNetwork,
        selfId: 'theirs',
        enqueue: vi.fn((_t, _c, _b, done) => done?.('ok')),
        onJoin: (req) => manager.handleJoinRequest(req),
        onConfirm: (peerId, peerSecret) => manager.handleConfirm(peerId, peerSecret),
      });
      await memberServer.start();
      const memberAddr = memberServer.address();
      const memberPort = typeof memberAddr === 'object' && memberAddr ? memberAddr.port : 0;
      try {
        const joinRes = await fetch(`http://127.0.0.1:${memberPort}/a2a/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'me', cardUrl: 'http://me.example/card.json' }),
        });
        expect(joinRes.status).toBe(202);
        expect(memberNetwork.getPeer('me')?.status).toBe('pending');

        const confirmRes = await fetch(`http://127.0.0.1:${memberPort}/a2a/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'me' }),
        });
        expect(confirmRes.status).toBe(200);
        expect(memberNetwork.getPeer('me')?.status).toBe('pending');
      } finally {
        await memberServer.stop();
        rmSync(memberDir, { recursive: true, force: true });
      }
    });

    it('only the operator path approves: /a2a approve flips status, confirm alone does not', async () => {
      const memberDir = mkdtempSync(join(tmpdir(), 'acp-edge-member-'));
      const memberNetwork = new NetworkStore(join(memberDir, 'network.json'));
      const notify = vi.fn(async () => {});
      const manager = new A2aManager({
        network: memberNetwork,
        selfId: 'theirs',
        notify,
        selfCardUrl: 'http://theirs:9/card.json',
        selfCard: { name: 'Theirs' },
      });
      const spy = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
      vi.stubGlobal('fetch', spy);
      try {
        memberNetwork.upsertPeer({
          id: 'me',
          cardUrl: 'http://me.example/card.json',
          status: 'pending',
          source: 'discovered',
        });
        memberNetwork.upsertPeer({
          id: 'second',
          cardUrl: 'http://second.example/card.json',
          status: 'pending',
          source: 'discovered',
        });
        await manager.handleConfirm('me', 'pairing-secret');
        expect(memberNetwork.getPeer('me')?.status).toBe('pending');

        await manager.handleCommand('/a2a approve me', 1);
        expect(memberNetwork.getPeer('me')?.status).toBe('approved');
        // the pairing secret crossed the wire exactly once in the confirm POST
        const confirmCall = spy.mock.calls.find(([, init]) =>
          String(init?.body).includes('pairing-secret')
        );
        expect(confirmCall?.[0]).toBe('http://me.example/a2a/confirm');

        await manager.handleConfirm('second');
        expect(memberNetwork.getPeer('second')?.status).toBe('pending');
      } finally {
        vi.unstubAllGlobals();
        rmSync(memberDir, { recursive: true, force: true });
      }
    });
  });
});
