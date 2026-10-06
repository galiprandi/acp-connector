import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aManager } from '../src/a2a-manager.ts';
import { NetworkStore } from '../src/network.ts';

let dir: string;
let network: NetworkStore;
let notify: ReturnType<typeof vi.fn>;
let manager: A2aManager;

const pendingPeer = {
  id: 'lean',
  cardUrl: 'http://localhost:8001/.well-known/agent-card.json',
  card: { name: 'Lean', description: 'Education assistant', skills: [{ id: 'edu.adapt' }] },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-mgr-'));
  network = new NetworkStore(join(dir, 'network.json'));
  notify = vi.fn(async () => {});
  manager = new A2aManager({ network, selfId: 'donna', notify });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pairing', () => {
  it('registers a join request as pending and notifies the owner', async () => {
    await manager.handleJoinRequest(pendingPeer);
    expect(network.getPeer('lean')?.status).toBe('pending');
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('Lean');
    expect(notify.mock.calls[0][0]).toContain('/a2a approve lean');
  });

  it('ignores a duplicate join request from an already-approved peer', async () => {
    network.upsertPeer({ ...pendingPeer, status: 'approved', source: 'discovered' });
    await manager.handleJoinRequest(pendingPeer);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('/a2a commands', () => {
  it('returns false for non-/a2a commands', async () => {
    expect(await manager.handleCommand('/cron list', 1)).toBe(false);
    expect(await manager.handleCommand('hello', 1)).toBe(false);
  });

  it('/a2a lists peers grouped by status', async () => {
    network.upsertPeer({ ...pendingPeer, status: 'approved', source: 'discovered' });
    network.upsertPeer({
      id: 'job',
      cardUrl: 'http://x',
      status: 'pending',
      source: 'discovered',
    });
    const reply = vi.fn(async () => {});
    manager.reply = reply;
    await manager.handleCommand('/a2a', 1);
    const text = reply.mock.calls[0][1];
    expect(text).toContain('lean');
    expect(text).toContain('job');
  });

  it('/a2a approve approves a pending peer', async () => {
    await manager.handleJoinRequest(pendingPeer);
    const reply = vi.fn(async () => {});
    manager.reply = reply;
    await manager.handleCommand('/a2a approve lean', 1);
    expect(network.getPeer('lean')?.status).toBe('approved');
    expect(reply.mock.calls[0][1]).toMatch(/approved/i);
  });

  it('/a2a reject and /a2a ignore update the peer status', async () => {
    await manager.handleJoinRequest(pendingPeer);
    const reply = vi.fn(async () => {});
    manager.reply = reply;
    await manager.handleCommand('/a2a reject lean', 1);
    expect(network.getPeer('lean')?.status).toBe('rejected');
    network.upsertPeer({ id: 'job', cardUrl: 'http://x', status: 'pending', source: 'discovered' });
    await manager.handleCommand('/a2a ignore job', 1);
    expect(network.getPeer('job')?.status).toBe('ignored');
  });

  it('/a2a revoke revokes an approved peer', async () => {
    network.upsertPeer({ ...pendingPeer, status: 'approved', source: 'discovered' });
    const reply = vi.fn(async () => {});
    manager.reply = reply;
    await manager.handleCommand('/a2a revoke lean', 1);
    expect(network.getPeer('lean')?.status).toBe('revoked');
  });

  it('/a2a approve on an unknown peer reports an error', async () => {
    const reply = vi.fn(async () => {});
    manager.reply = reply;
    await manager.handleCommand('/a2a approve ghost', 1);
    expect(reply.mock.calls[0][1]).toMatch(/unknown|not found/i);
  });
});

describe('join/confirm handshake', () => {
  it('handleConfirm approves a pending peer and notifies', async () => {
    await manager.handleJoinRequest(pendingPeer);
    await manager.handleConfirm('lean');
    expect(network.getPeer('lean')?.status).toBe('approved');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('approved our join request');
  });

  it('handleConfirm ignores non-pending peers', async () => {
    await manager.handleConfirm('ghost');
    expect(network.getPeer('ghost')).toBeUndefined();
  });

  it('joinPeer POSTs our card to the peer origin', async () => {
    const peerDir = mkdtempSync(join(tmpdir(), 'acp-join-'));
    const fetchSpy = vi.fn(
      async () => new Response('{"status":"pending-approval"}', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      manager = new A2aManager({
        network,
        selfId: 'donna',
        notify,
        selfCardUrl: 'http://me:1/.well-known/agent-card.json',
        selfCard: { name: 'Donna' },
      });
      network.upsertPeer({
        id: 'lean',
        cardUrl: 'http://peer:99/x',
        status: 'pending',
        source: 'discovered',
      });
      await manager.joinPeer('lean');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://peer:99/a2a/join',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.id).toBe('donna');
      expect(body.card.name).toBe('Donna');
    } finally {
      vi.unstubAllGlobals();
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});

describe('startup reminders and discovery', () => {
  it('remindPending notifies about pending requests only when they exist', async () => {
    await manager.remindPending();
    expect(notify).not.toHaveBeenCalled();
    await manager.handleJoinRequest(pendingPeer);
    notify.mockClear();
    await manager.remindPending();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain('lean');
  });

  it('notifyDiscovered only announces peers not already known', async () => {
    network.upsertPeer({ ...pendingPeer, status: 'approved', source: 'discovered' });
    await manager.notifyDiscovered([
      { id: 'lean', cardUrl: 'http://x' },
      { id: 'job', cardUrl: 'http://y' },
    ]);
    // lean already known → not re-announced; job is fresh
    expect(notify.mock.calls[0][0]).toContain('job');
    expect(notify.mock.calls[0][0]).not.toContain('• lean');
    expect(network.getPeer('job')?.status).toBe('pending');
    expect(network.getPeer('lean')?.status).toBe('approved');
  });
});

describe('peer card refresh and registry announce', () => {
  it('refreshPeerCard fetches the well-known card into the peer record', async () => {
    const card = { name: 'Lean', skills: [{ id: 'edu.adapt' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(card)))
    );
    try {
      network.upsertPeer({
        id: 'lean',
        cardUrl: 'http://p:1/.well-known/agent-card.json',
        status: 'approved',
        source: 'discovered',
      });
      await manager.refreshPeerCard('lean');
      expect(network.getPeer('lean')?.card).toEqual(card);
      expect(network.getPeer('lean')?.lastSeen).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refreshPeerCard leaves the card untouched on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    try {
      network.upsertPeer({ ...pendingPeer, status: 'approved' });
      await manager.refreshPeerCard('lean');
      expect(network.getPeer('lean')?.card).toEqual(pendingPeer.card);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('announceToRegistry POSTs self card to the registry', async () => {
    const spy = vi.fn(async () => new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', spy);
    try {
      manager = new A2aManager({
        network,
        selfId: 'donna',
        notify,
        selfCardUrl: 'http://me:1/.well-known/agent-card.json',
        selfCard: { name: 'Donna' },
      });
      await manager.announceToRegistry('http://registry:9');
      expect(spy).toHaveBeenCalledWith(
        'http://registry:9/a2a/registry/announce',
        expect.objectContaining({ method: 'POST' })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
