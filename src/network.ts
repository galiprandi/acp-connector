import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * status, and already-processed task ids. Persisted to a JSON file owned
 * by the bridge — never edited by hand, never committed.
 */
export class NetworkStore {
  private state: NetworkState;

  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      let raw: string;
      let parsed: NetworkState;
      try {
        raw = readFileSync(filePath, 'utf8');
        parsed = JSON.parse(raw) as NetworkState;
      } catch {
        // Corrupt runtime state must not kill the bridge: back it up and
        // start fresh — peers can be re-approved, a dead bridge cannot.
        renameSync(filePath, `${filePath}.corrupt`);
        this.state = {
          schemaVersion: NETWORK_SCHEMA_VERSION,
          role: 'peer',
          peers: [],
          seenTaskIds: [],
        };
        return;
      }
      if (parsed.schemaVersion !== NETWORK_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported network.json schemaVersion ${parsed.schemaVersion} (expected ${NETWORK_SCHEMA_VERSION})`
        );
      }
      this.state = parsed;
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
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
      Object.assign(existing, peer, { id: existing.id });
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
