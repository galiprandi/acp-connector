import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aServer } from '../src/a2a.ts';
import type { A2aConfig } from '../src/config.ts';
import { NetworkStore } from '../src/network.ts';

let dir: string;
let network: NetworkStore;
let server: A2aServer;
let port: number;

const config: A2aConfig = {
  enabled: true,
  port: 0,
  card: {
    name: 'Donna',
    description: 'Personal assistant',
    skills: [{ id: 'wa.send', name: 'Send WhatsApp', description: 'Send WhatsApp' }],
  },
};

function rpc(method: string, params: unknown, peerId?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (peerId) headers['X-A2A-Peer-Id'] = peerId;
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());
}

function sendMessage(text: string, peerId = 'lean', taskId = 'task-1', chain: string[] = ['lean']) {
  return rpc(
    'message/send',
    {
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [{ kind: 'text', text }],
        metadata: { 'a2a.taskId': taskId, 'a2a.delegationChain': chain },
      },
    },
    peerId
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acp-a2a-'));
  network = new NetworkStore(join(dir, 'network.json'));
  server = new A2aServer({
    config,
    network,
    selfId: 'donna',
    enqueue: (_text, _chatId, _blocks, onComplete) => {
      onComplete?.('agent reply');
    },
  });
  await server.start();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  port = addr.port;
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('A2aServer', () => {
  it('serves the agent card at the well-known URI', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe('Donna');
    expect(card.url).toContain(`:${port}`);
  });

  it('rejects messages from unknown peers without processing', async () => {
    const enqueue = vi.fn();
    server.enqueue = enqueue;
    const res = await sendMessage('hello', 'stranger');
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32001);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects messages from non-approved peers', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'pending',
      source: 'discovered',
    });
    const res = await sendMessage('hello');
    expect(res.error.code).toBe(-32001);
  });

  it('enqueues prompts from approved peers and returns an agent message', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'discovered',
    });
    const enqueue = vi.fn((_t, _c, _b, onComplete) => onComplete?.('agent reply'));
    server.enqueue = enqueue;
    const res = await sendMessage('adapt this exercise');
    expect(res.result).toBeDefined();
    expect(res.result.role).toBe('agent');
    expect(res.result.parts[0].text).toBe('agent reply');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toContain('[A2A from lean');
    expect(enqueue.mock.calls[0][0]).toContain('adapt this exercise');
  });

  it('deduplicates repeated task ids', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'discovered',
    });
    const enqueue = vi.fn((_t, _c, _b, onComplete) => onComplete?.('reply'));
    server.enqueue = enqueue;
    await sendMessage('hello', 'lean', 'task-dup');
    const res = await sendMessage('hello', 'lean', 'task-dup');
    expect(res.error.code).toBe(-32002);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects delegation loops', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'discovered',
    });
    const res = await sendMessage('hello', 'lean', 'task-loop', ['lean', 'donna']);
    expect(res.error.code).toBe(-32003);
  });

  it('returns a JSON-RPC method-not-found error for unknown methods', async () => {
    const res = await rpc('bogus/method', {}, 'lean');
    expect(res.error.code).toBe(-32601);
  });
});

describe('A2aServer registry mode', () => {
  function announce(body: unknown) {
    return fetch(`http://127.0.0.1:${port}/a2a/registry/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 404 for registry endpoints when role is peer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/a2a/registry/agents`);
    expect(res.status).toBe(404);
    const resPost = await announce({ id: 'lean', cardUrl: 'http://x' });
    expect(resPost.status).toBe(404);
  });

  describe('with registry role', () => {
    beforeEach(() => {
      network.role = 'registry';
      network.upsertPeer({
        id: 'edu',
        cardUrl: 'http://edu.example',
        status: 'approved',
        source: 'declared',
        card: {
          name: 'Edu',
          skills: [{ id: 'edu.adapt', name: 'Adapt exercise' }],
        },
      });
      network.upsertPeer({
        id: 'shop',
        cardUrl: 'http://shop.example',
        status: 'approved',
        source: 'declared',
        card: {
          name: 'Shop',
          skills: [{ id: 'shop.order', name: 'Order groceries' }],
        },
      });
      network.upsertPeer({
        id: 'pending-peer',
        cardUrl: 'http://pending.example',
        status: 'pending',
        source: 'discovered',
        card: { name: 'Pending', skills: [{ id: 'edu.adapt', name: 'Adapt' }] },
      });
    });

    it('lists only approved peers with their cards', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/a2a/registry/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents).toHaveLength(2);
      const ids = body.agents.map((a: { id: string }) => a.id);
      expect(ids).toContain('edu');
      expect(ids).toContain('shop');
      expect(ids).not.toContain('pending-peer');
      const edu = body.agents.find((a: { id: string }) => a.id === 'edu');
      expect(edu.cardUrl).toBe('http://edu.example');
      expect(edu.card.name).toBe('Edu');
    });

    it('filters agents by skill', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/a2a/registry/agents?skill=edu.adapt`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe('edu');
    });

    it('updates cardUrl, card and lastSeen on announce from an approved peer', async () => {
      const res = await announce({
        id: 'edu',
        cardUrl: 'http://edu-new.example',
        card: { name: 'Edu v2', skills: [{ id: 'edu.adapt', name: 'Adapt v2' }] },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      const peer = network.getPeer('edu');
      expect(peer?.cardUrl).toBe('http://edu-new.example');
      expect(peer?.card?.name).toBe('Edu v2');
      expect(peer?.lastSeen).toBeDefined();
      expect(Number.isNaN(Date.parse(peer?.lastSeen ?? ''))).toBe(false);
    });

    it('rejects announce from a non-approved peer', async () => {
      const res = await announce({
        id: 'pending-peer',
        cardUrl: 'http://pending.example',
        card: { name: 'Pending' },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('peer not approved');
    });
  });
});

describe('agent-facing endpoints (loopback)', () => {
  it('GET /a2a/peers lists approved peers with their skills', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'discovered',
      card: { name: 'Lean', skills: [{ id: 'edu.adapt' }] },
    });
    network.upsertPeer({
      id: 'stranger',
      cardUrl: 'http://y',
      status: 'pending',
      source: 'discovered',
    });
    const res = await fetch(`http://127.0.0.1:${port}/a2a/peers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].id).toBe('lean');
    expect(body.peers[0].skills).toEqual(['edu.adapt']);
  });

  it('POST /a2a/delegate forwards a task to an approved peer via message/send', async () => {
    // Stand up a second server as the peer
    const peerDir = mkdtempSync(join(tmpdir(), 'acp-peer-'));
    const peerNetwork = new NetworkStore(join(peerDir, 'network.json'));
    peerNetwork.upsertPeer({
      id: 'donna',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'declared',
    });
    const peerEnqueue = vi.fn((_t, _c, _b, done) => done?.('peer did the thing'));
    const peer = new A2aServer({
      config: { enabled: true, port: 0, card: { name: 'Lean', description: 'x' } },
      network: peerNetwork,
      selfId: 'lean',
      enqueue: peerEnqueue,
    });
    await peer.start();
    const paddr = peer.address();
    const pport = typeof paddr === 'object' && paddr ? paddr.port : 0;

    network.upsertPeer({
      id: 'lean',
      cardUrl: `http://127.0.0.1:${pport}/.well-known/agent-card.json`,
      status: 'approved',
      source: 'discovered',
    });

    const res = await fetch(`http://127.0.0.1:${port}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'lean', text: 'adapt this exercise', taskId: 'dt-1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toBe('peer did the thing');
    // peer received the task prefixed with our id and the chain
    const sentText = peerEnqueue.mock.calls[0][0] as string;
    expect(sentText).toContain('[A2A from donna');
    expect(sentText).toContain('adapt this exercise');

    await peer.stop();
    rmSync(peerDir, { recursive: true, force: true });
  });

  it('POST /a2a/delegate rejects unknown or unapproved peers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'nobody', text: 'hi' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('edge cases', () => {
  it('returns parse error for malformed JSON-RPC bodies', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-A2A-Peer-Id': 'lean' },
      body: 'not json{',
    }).then((r) => r.json());
    expect(res.error.code).toBe(-32700);
  });

  it('handles messages with no text parts', async () => {
    network.upsertPeer({
      id: 'lean',
      cardUrl: 'http://x',
      status: 'approved',
      source: 'discovered',
    });
    const enqueue = vi.fn((_t, _c, _b, done) => done?.('ok'));
    server.enqueue = enqueue;
    const res = await rpc(
      'message/send',
      { message: { role: 'user', messageId: 'm9', parts: [{ kind: 'data', data: { a: 1 } }] } },
      'lean'
    );
    expect(res.result.role).toBe('agent');
    expect(enqueue).toHaveBeenCalled();
  });

  it('delegate returns 502 when the peer errors', async () => {
    const peerDir = mkdtempSync(join(tmpdir(), 'acp-peer-err-'));
    const peerNetwork = new NetworkStore(join(peerDir, 'network.json'));
    peerNetwork.upsertPeer({
      id: 'donna',
      cardUrl: 'http://x',
      status: 'pending',
      source: 'declared',
    });
    const peer = new A2aServer({
      config: { enabled: true, port: 0, card: { name: 'Lean', description: 'x' } },
      network: peerNetwork,
      selfId: 'lean',
      enqueue: (_t, _c, _b, done) => done?.('ok'),
    });
    await peer.start();
    const paddr = peer.address();
    const pport = typeof paddr === 'object' && paddr ? paddr.port : 0;

    // donna stays pending on the peer side → the peer rejects the task
    network.upsertPeer({
      id: 'lean',
      cardUrl: `http://127.0.0.1:${pport}/card`,
      status: 'approved',
      source: 'discovered',
    });
    const res = await fetch(`http://127.0.0.1:${port}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'lean', text: 'hi' }),
    });
    expect(res.status).toBe(502);
    await peer.stop();
    rmSync(peerDir, { recursive: true, force: true });
  });

  it('delegate rejects peers without cardUrl', async () => {
    network.upsertPeer({ id: 'lean', cardUrl: '', status: 'approved', source: 'declared' });
    const res = await fetch(`http://127.0.0.1:${port}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'lean', text: 'hi' }),
    });
    expect(res.status).toBe(400);
  });
});
