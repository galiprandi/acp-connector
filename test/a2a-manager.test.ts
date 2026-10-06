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
