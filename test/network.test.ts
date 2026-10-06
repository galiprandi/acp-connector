import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NetworkStore, type Peer } from '../src/network.ts';

let dir: string;
let path: string;
let store: NetworkStore;

function makePeer(id: string, status: Peer['status'] = 'pending'): Peer {
  return {
    id,
    cardUrl: `http://localhost:8000/${id}/.well-known/agent-card.json`,
    status,
    source: 'discovered',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-net-'));
  path = join(dir, 'network.json');
  store = new NetworkStore(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NetworkStore persistence', () => {
  it('creates an empty state when the file does not exist', () => {
    expect(store.listPeers()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('persists peers to disk', () => {
    store.upsertPeer(makePeer('lean'));
    store.save();
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.peers).toHaveLength(1);
    expect(raw.peers[0].id).toBe('lean');
  });

  it('reloads state across instances', () => {
    store.upsertPeer(makePeer('lean', 'approved'));
    store.save();
    const reloaded = new NetworkStore(path);
    expect(reloaded.getPeer('lean')?.status).toBe('approved');
  });

  it('rejects an unsupported schemaVersion', () => {
    store.upsertPeer(makePeer('x'));
    store.save();
    const corrupted = JSON.parse(readFileSync(path, 'utf8'));
    corrupted.schemaVersion = 999;
    writeFileSync(path, JSON.stringify(corrupted));
    expect(() => new NetworkStore(path)).toThrow(/schemaVersion/i);
  });
});

describe('peer management', () => {
  it('adds a peer as pending by default', () => {
    store.upsertPeer(makePeer('lean'));
    expect(store.getPeer('lean')?.status).toBe('pending');
  });

  it('updates an existing peer without duplicating', () => {
    store.upsertPeer(makePeer('lean'));
    store.upsertPeer({ ...makePeer('lean'), lastSeen: 'now' });
    expect(store.listPeers()).toHaveLength(1);
    expect(store.getPeer('lean')?.lastSeen).toBe('now');
  });

  it('lists peers filtered by status', () => {
    store.upsertPeer(makePeer('a', 'approved'));
    store.upsertPeer(makePeer('b', 'pending'));
    store.upsertPeer(makePeer('c', 'approved'));
    expect(store.listPeers('approved').map((p) => p.id)).toEqual(['a', 'c']);
    expect(store.listPeers('pending').map((p) => p.id)).toEqual(['b']);
  });

  it('isApproved returns true only for approved peers', () => {
    store.upsertPeer(makePeer('a', 'approved'));
    store.upsertPeer(makePeer('b', 'pending'));
    expect(store.isApproved('a')).toBe(true);
    expect(store.isApproved('b')).toBe(false);
    expect(store.isApproved('unknown')).toBe(false);
  });
});

describe('status transitions', () => {
  beforeEach(() => {
    store.upsertPeer(makePeer('lean'));
  });

  it('allows pending -> approved', () => {
    store.setStatus('lean', 'approved');
    expect(store.getPeer('lean')?.status).toBe('approved');
    expect(store.getPeer('lean')?.joinedAt).toBeDefined();
  });

  it('allows pending -> rejected and pending -> ignored', () => {
    store.setStatus('lean', 'rejected');
    expect(store.getPeer('lean')?.status).toBe('rejected');
    store.setStatus('lean', 'pending');
    store.setStatus('lean', 'ignored');
    expect(store.getPeer('lean')?.status).toBe('ignored');
  });

  it('allows ignored -> approved (unignore) and approved -> revoked', () => {
    store.setStatus('lean', 'ignored');
    store.setStatus('lean', 'approved');
    expect(store.getPeer('lean')?.status).toBe('approved');
    store.setStatus('lean', 'revoked');
    expect(store.getPeer('lean')?.status).toBe('revoked');
  });

  it('allows revoked -> pending (rejoin request)', () => {
    store.setStatus('lean', 'approved');
    store.setStatus('lean', 'revoked');
    store.setStatus('lean', 'pending');
    expect(store.getPeer('lean')?.status).toBe('pending');
  });

  it('rejects invalid transitions', () => {
    expect(() => store.setStatus('lean', 'revoked')).toThrow(/invalid/i);
    store.setStatus('lean', 'approved');
    expect(() => store.setStatus('lean', 'rejected')).toThrow(/invalid/i);
  });

  it('throws when transitioning an unknown peer', () => {
    expect(() => store.setStatus('ghost', 'approved')).toThrow(/unknown/i);
  });
});

describe('task dedup', () => {
  it('detects previously seen task ids', () => {
    expect(store.hasSeenTask('t1')).toBe(false);
    store.markTaskSeen('t1');
    expect(store.hasSeenTask('t1')).toBe(true);
  });

  it('persists seen task ids', () => {
    store.markTaskSeen('t1');
    store.save();
    const reloaded = new NetworkStore(path);
    expect(reloaded.hasSeenTask('t1')).toBe(true);
  });
});

describe('delegation chain', () => {
  it('rejects a chain that already contains this agent', () => {
    expect(() => store.checkDelegationChain(['donna', 'lean'], 'donna')).toThrow(/loop/i);
  });

  it('rejects a chain that exceeds the depth limit', () => {
    expect(() => store.checkDelegationChain(['a', 'b', 'c', 'd'], 'me', 3)).toThrow(/depth/i);
  });

  it('accepts a clean chain', () => {
    expect(() => store.checkDelegationChain(['lean'], 'donna')).not.toThrow();
  });
});

describe('corrupt state file', () => {
  it('recovers by backing up the corrupt file and starting fresh', () => {
    writeFileSync(path, '{broken json!!!');
    const s = new NetworkStore(path);
    expect(s.listPeers()).toEqual([]);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });
});

describe('upsert safety', () => {
  it('never downgrades an approved peer to pending on rediscovery', () => {
    store.upsertPeer(makePeer('lean', 'approved'));
    store.upsertPeer({ ...makePeer('lean'), status: 'pending' });
    expect(store.getPeer('lean')?.status).toBe('approved');
  });

  it('preserves joinedAt when an approved peer is rediscovered', () => {
    store.upsertPeer(makePeer('lean'));
    store.setStatus('lean', 'approved');
    const joined = store.getPeer('lean')?.joinedAt;
    store.upsertPeer({ ...makePeer('lean'), status: 'pending', cardUrl: 'http://new-url' });
    expect(store.getPeer('lean')?.cardUrl).toBe('http://new-url');
    expect(store.getPeer('lean')?.status).toBe('approved');
    expect(store.getPeer('lean')?.joinedAt).toBe(joined);
  });
});
