import { log } from './logger.js';
import type { NetworkStore, PeerStatus } from './network.js';

export type NotifyFn = (text: string) => Promise<void>;
export type ReplyFn = (chatId: number | string, text: string) => Promise<void>;

export interface JoinRequest {
  id: string;
  cardUrl: string;
  card?: Record<string, unknown>;
}

export interface A2aManagerOptions {
  network: NetworkStore;
  selfId: string;
  /** Notify the owner on all configured channels (first response wins). */
  notify: NotifyFn;
  /** This agent's public card URL, sent to peers during join. */
  selfCardUrl?: string;
  /** This agent's own Agent Card, sent to peers during join. */
  selfCard?: Record<string, unknown>;
  /** Called whenever an approval changes (peer approved or us confirmed). */
  onMembershipChanged?: () => Promise<void>;
}

const STATUS_ICON: Record<string, string> = {
  approved: '✅',
  pending: '⏳',
  rejected: '❌',
  ignored: '🔕',
  revoked: '🚫',
};

/**
 * Network membership management: pairing requests, owner approval,
 * and the /a2a command family. Answered by the bridge — commands never
 * reach the agent. This is deployment glue around the A2A protocol:
 * the spec standardizes cards and tasks, not how owners grant trust.
 */
export class A2aManager {
  reply: ReplyFn = async () => {};
  private network: NetworkStore;
  private selfId: string;
  private notify: NotifyFn;
  private selfCardUrl?: string;
  private selfCard?: Record<string, unknown>;
  onMembershipChanged?: () => Promise<void>;

  constructor(opts: A2aManagerOptions) {
    this.network = opts.network;
    this.selfId = opts.selfId;
    this.notify = opts.notify;
    this.selfCardUrl = opts.selfCardUrl;
    this.selfCard = opts.selfCard;
    if (opts.onMembershipChanged) this.onMembershipChanged = opts.onMembershipChanged;
  }

  /**
   * Registers an inbound join request as a pending peer and notifies
   * the owner. Already-approved peers are silently acknowledged.
   */
  async handleJoinRequest(req: JoinRequest): Promise<void> {
    const existing = this.network.getPeer(req.id);
    if (existing && existing.status === 'approved') return;

    if (!existing) {
      this.network.upsertPeer({
        id: req.id,
        cardUrl: req.cardUrl,
        card: req.card,
        status: 'pending',
        source: 'discovered',
      });
    }
    this.network.save();

    const skills = Array.isArray(req.card?.skills)
      ? (req.card.skills as Array<{ id: string }>).map((s) => s.id).join(', ')
      : 'none declared';
    await this.notify(
      `🔎 Network join request\n` +
        `Peer: ${req.card?.name ?? req.id} (${req.id})\n` +
        `Skills: ${skills}\n\n` +
        `/a2a approve ${req.id} · /a2a reject ${req.id} · /a2a ignore ${req.id}`
    );
    log.info(`A2A join request from '${req.id}' — pending owner approval`);
  }

  /**
   * Outbound join: POSTs our card to the peer's /a2a/join endpoint.
   * Completes when the peer's owner approves and it confirms us back.
   */
  async joinPeer(id: string): Promise<void> {
    const peer = this.network.getPeer(id);
    if (!peer) throw new Error(`Unknown peer: ${id}`);
    const base = new URL(peer.cardUrl).origin;
    const res = await fetch(`${base}/a2a/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.selfId, cardUrl: this.selfCardUrl, card: this.selfCard }),
    });
    if (!res.ok) throw new Error(`join failed: HTTP ${res.status}`);
  }

  /**
   * Inbound confirmation: the peer's owner approved us and it called back.
   * Approves the peer locally — completing the double opt-in.
   */
  async handleConfirm(peerId: string): Promise<void> {
    const peer = this.network.getPeer(peerId);
    if (peer && peer.status === 'pending') {
      this.network.setStatus(peerId, 'approved');
      this.network.save();
      await this.notify(`✅ ${peerId} approved our join request — peer is now trusted.`);
      await this.onMembershipChanged?.();
    }
  }

  /**
   * Notifies the owner about newly discovered peers (not yet joined).
   */
  async notifyDiscovered(peers: Array<{ id: string; cardUrl: string }>): Promise<void> {
    const fresh = peers.filter((p) => !this.network.getPeer(p.id));
    for (const p of fresh) {
      this.network.upsertPeer({
        id: p.id,
        cardUrl: p.cardUrl,
        status: 'pending',
        source: 'discovered',
      });
    }
    if (fresh.length === 0) return;
    this.network.save();
    await this.notify(
      `🔎 Discovered ${fresh.length} agent(s) on the network:\n` +
        fresh.map((p) => `  • ${p.id} (${p.cardUrl})`).join('\n') +
        `\n\nTo request membership: /a2a join <id>`
    );
  }

  /**
   * Startup reminder: pending join requests survive restarts and must
   * not be silently forgotten.
   */
  async remindPending(): Promise<void> {
    const pending = this.network.listPeers('pending');
    if (pending.length === 0) return;
    await this.notify(
      `⏰ ${pending.length} pending join request(s):\n` +
        pending.map((p) => `  • ${p.id}`).join('\n') +
        '\n\n/a2a approve|reject|ignore <id>'
    );
  }

  /** Handles the /a2a command family. Returns false for other commands. */
  async handleCommand(text: string, chatId: number | string): Promise<boolean> {
    const parts = text.slice(1).split(/\s+/);
    if (parts[0] !== 'a2a') return false;

    const sub = parts[1] ?? '';
    const arg = parts[2];

    switch (sub) {
      case '':
        return this._status(chatId);
      case 'pending':
        return this._list(chatId, 'pending');
      case 'peers':
        return this._list(chatId, 'approved');
      case 'join':
        return this._join(chatId, arg);
      case 'approve':
      case 'reject':
      case 'ignore':
      case 'revoke':
        return this._setStatus(chatId, arg, sub);
      case 'card':
        return this._card(chatId);
      default:
        await this.reply(
          chatId,
          'Usage: /a2a [pending|peers|approve|reject|ignore|revoke|card] <id>'
        );
        return true;
    }
  }

  private async _status(chatId: number | string): Promise<boolean> {
    const lines = [`🌐 A2A network — ${this.selfId}`];
    for (const status of ['approved', 'pending', 'ignored', 'revoked'] as const) {
      const peers = this.network.listPeers(status);
      if (peers.length === 0) continue;
      lines.push(`\n${STATUS_ICON[status]} ${status} (${peers.length}):`);
      for (const p of peers) {
        lines.push(`  • ${p.id}${p.lastSeen ? ` — seen ${p.lastSeen}` : ''}`);
      }
    }
    if (this.network.listPeers().length === 0) lines.push('No peers yet.');
    await this.reply(chatId, lines.join('\n'));
    return true;
  }

  private async _list(chatId: number | string, status: 'pending' | 'approved'): Promise<boolean> {
    const peers = this.network.listPeers(status);
    const text =
      peers.length === 0
        ? `No ${status} peers.`
        : peers.map((p) => `${STATUS_ICON[status]} ${p.id} — ${p.cardUrl}`).join('\n');
    await this.reply(chatId, text);
    return true;
  }

  private async _setStatus(
    chatId: number | string,
    id: string | undefined,
    action: 'approve' | 'reject' | 'ignore' | 'revoke'
  ): Promise<boolean> {
    if (!id) {
      await this.reply(chatId, `Usage: /a2a ${action} <peer-id>`);
      return true;
    }
    const targets: Record<string, PeerStatus> = {
      approve: 'approved',
      reject: 'rejected',
      ignore: 'ignored',
      revoke: 'revoked',
    };
    const target = targets[action];
    try {
      this.network.setStatus(id, target);
      this.network.save();
      await this.reply(chatId, `${STATUS_ICON[target]} ${id} → ${target}`);
      // Double opt-in completion: tell the requester we approved them.
      if (action === 'approve') {
        const peer = this.network.getPeer(id);
        if (peer?.cardUrl) {
          const base = new URL(peer.cardUrl).origin;
          await fetch(`${base}/a2a/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: this.selfId }),
          }).catch(() => {});
        }
        await this.onMembershipChanged?.();
      }
    } catch (err) {
      await this.reply(chatId, `⚠️ ${(err as Error).message}`);
    }
    return true;
  }

  private async _join(chatId: number | string, id: string | undefined): Promise<boolean> {
    if (!id) {
      await this.reply(chatId, 'Usage: /a2a join <peer-id>');
      return true;
    }
    try {
      await this.joinPeer(id);
      await this.reply(
        chatId,
        `📨 Join request sent to ${id} — waiting for their owner's approval.`
      );
    } catch (err) {
      await this.reply(chatId, `⚠️ ${(err as Error).message}`);
    }
    return true;
  }

  private async _card(_chatId: number | string): Promise<boolean> {
    await this.reply(_chatId, `Card endpoint: /.well-known/agent-card.json (id: ${this.selfId})`);
    return true;
  }
}
