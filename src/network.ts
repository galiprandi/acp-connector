import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StateStore } from './state.js';

export const NETWORK_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

export type PeerStatus = 'pending' | 'approved' | 'rejected' | 'ignored' | 'revoked';
export type PeerSource = 'declared' | 'discovered';
export type NetworkRole = 'peer' | 'registry';

export interface Peer {
  id: string;
  cardUrl: string;
  status: PeerStatus;
  source: PeerSource;
  card?: Record<string, unknown>;
  joinedAt?: string;
  lastSeen?: string;
  /** Secret this bridge expects FROM this peer when it signs requests to us. */
  auth?: { secret: string; issuedAt: string };
}

export interface NetworkState {
  schemaVersion: number;
  role: NetworkRole;
  peers: Peer[];
  seenTaskIds: string[];
}

const TRANSITIONS: Record<PeerStatus, PeerStatus[]> = {
  pending: ['approved', 'rejected', 'ignored'],
  approved: ['revoked'],
  rejected: ['pending'],
  ignored: ['pending', 'approved'],
  revoked: ['pending'],
};

const MAX_SEEN_TASK_IDS = 10_000;

/**
 * Runtime network state for the A2A layer: known peers, their trust
 * status, and already-processed task ids. Persisted inside
 * `.acp-connector/state.json` via StateStore — never edited by hand,
 * never committed.
 */
export class NetworkStore {
  private state: NetworkState;
  private store: StateStore | null;

  constructor(store?: StateStore | string | null) {
    // Accepts a StateStore (production) or a file path (tests/legacy) —
    // a path is wrapped in its own StateStore so persistence semantics
    // stay identical either way.
    this.store = store instanceof StateStore ? store : store ? StateStore.load(store) : null;
    const persisted = this.store?.get('network') as NetworkState | undefined;
    if (persisted && typeof persisted === 'object' && Array.isArray(persisted.peers)) {
      if (persisted.schemaVersion !== NETWORK_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported state.network schemaVersion ${persisted.schemaVersion} (expected ${NETWORK_SCHEMA_VERSION})`
        );
      }
      this.state = persisted;
    } else {
      this.state = {
        schemaVersion: NETWORK_SCHEMA_VERSION,
        role: 'peer',
        peers: [],
        seenTaskIds: [],
      };
    }
  }

  save(): void {
    this.store?.set('network', this.state);
  }

  get role(): NetworkRole {
    return this.state.role;
  }

  set role(role: NetworkRole) {
    this.state.role = role;
  }

  getPeer(id: string): Peer | undefined {
    return this.state.peers.find((p) => p.id === id);
  }

  listPeers(status?: PeerStatus): Peer[] {
    return status ? this.state.peers.filter((p) => p.status === status) : [...this.state.peers];
  }

  upsertPeer(peer: Peer): void {
    const existing = this.getPeer(peer.id);
    if (existing) {
      // Never downgrade trust via rediscovery: an approved peer stays
      // approved even if a discovery strategy re-registers it as pending.
      const status = existing.status === 'approved' ? 'approved' : peer.status;
      Object.assign(existing, peer, { id: existing.id, status });
    } else {
      this.state.peers.push(peer);
    }
  }

  setStatus(id: string, next: PeerStatus): void {
    const peer = this.getPeer(id);
    if (!peer) throw new Error(`Unknown peer: ${id}`);
    if (!TRANSITIONS[peer.status].includes(next)) {
      throw new Error(`Invalid peer status transition: ${peer.status} -> ${next}`);
    }
    peer.status = next;
    if (next === 'approved' && !peer.joinedAt) {
      peer.joinedAt = new Date().toISOString();
    }
  }

  isApproved(id: string): boolean {
    return this.getPeer(id)?.status === 'approved';
  }

  /**
   * Issues (or returns the already-issued) pairing secret for a peer.
   * Idempotent by design: secrets are never rotated silently — rotation
   * requires explicit operator action (future secret-rotation flow).
   */
  issuePeerAuth(id: string): string {
    const peer = this.getPeer(id);
    if (!peer) throw new Error(`Unknown peer: ${id}`);
    if (peer.auth?.secret) return peer.auth.secret;
    const secret = randomBytes(24).toString('hex');
    peer.auth = { secret, issuedAt: new Date().toISOString() };
    this.save();
    return secret;
  }

  /**
   * Timing-safe verification of a peer's HMAC-SHA256 signature over the
   * raw request body. Returns false when the peer has no secret yet
   * (legacy pairing) or inputs are missing / length-mismatched.
   */
  verifyPeerSignature(id: string, body: string, signatureHex: string): boolean {
    const secret = this.getPeer(id)?.auth?.secret;
    if (!secret || !signatureHex || !body) return false;
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  hasSeenTask(taskId: string): boolean {
    return this.state.seenTaskIds.includes(taskId);
  }

  markTaskSeen(taskId: string): void {
    if (this.hasSeenTask(taskId)) return;
    this.state.seenTaskIds.push(taskId);
    if (this.state.seenTaskIds.length > MAX_SEEN_TASK_IDS) {
      this.state.seenTaskIds.splice(0, this.state.seenTaskIds.length - MAX_SEEN_TASK_IDS);
    }
  }

  /**
   * Guards against delegation loops (A -> B -> A) and runaway chains.
   * The chain lists agent ids that already touched this task.
   */
  checkDelegationChain(
    chain: string[],
    selfId: string,
    maxDepth: number = DEFAULT_MAX_DELEGATION_DEPTH
  ): void {
    if (chain.includes(selfId)) {
      throw new Error(
        `Delegation loop detected: chain ${chain.join(' -> ')} already includes ${selfId}`
      );
    }
    if (chain.length >= maxDepth) {
      throw new Error(`Delegation depth limit exceeded (${maxDepth})`);
    }
  }
}

export interface AuditEntry {
  event: string;
  peer?: string;
  taskId?: string;
  detail?: string;
  [key: string]: unknown;
}

/**
 * Append-only audit trail for network events: joins, approvals,
 * delegations, revocations. Separate from network.json — that file is
 * current state, this log is history.
 */
export class AuditLog {
  constructor(private filePath: string) {}

  write(entry: AuditEntry): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      appendFileSync(this.filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch {
      // Audit must never break the bridge.
    }
  }
}
