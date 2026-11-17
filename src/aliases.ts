import type { SenderInfo } from './identity.js';
import { aliasDisplayName, platformLabel } from './identity.js';
import type { StateStore } from './state.js';

/**
 * Maps agent-facing chat aliases (`Telegram/Familia`,
 * `Discord/Germán Aliprandi`) to real platform chat ids.
 *
 * Fed by every inbound user message — self-healing on renames. Persisted
 * in `.acp-connector/state.json` via StateStore so aliases survive
 * restarts; the in-memory map is the runtime source of truth.
 *
 * Raw platform ids are never exposed through the API — only aliases,
 * platform, kind and display name.
 */

export interface AliasEntry {
  /** Agent-facing alias, e.g. `Telegram/Familia`. */
  alias: string;
  platform: string;
  chatId: string;
  kind: 'dm' | 'group';
  /** Display name the alias was derived from. */
  name: string;
  lastSeen: number;
}

export type ResolveResult = { ok: true; entry: AliasEntry } | { ok: false; error: string };

const norm = (s: string) => s.trim().toLowerCase();

export class AliasDirectory {
  /** chatId → entry (one entry per chat; re-register updates it). */
  private byChat = new Map<string, AliasEntry>();
  /** normalized alias → chatIds (multiple chats can share a display name). */
  private byAlias = new Map<string, Set<string>>();
  private store: StateStore | null;

  constructor(store?: StateStore | null) {
    this.store = store ?? null;
    const raw = this.store?.get('aliases');
    if (Array.isArray(raw)) {
      for (const e of raw as AliasEntry[]) {
        if (e && typeof e.alias === 'string' && typeof e.chatId === 'string') {
          this._upsert(e);
        }
      }
    }
  }

  /**
   * Register (or refresh) the alias for a chat. `sender` comes from the
   * inbound message; for DMs the sender name doubles as chat name.
   */
  register(platform: string, chatId: string | number, sender: SenderInfo): void {
    const name = aliasDisplayName(sender);
    if (!name) return;
    const entry: AliasEntry = {
      alias: `${platformLabel(platform)}/${name}`,
      platform,
      chatId: String(chatId),
      kind: sender.isGroup ? 'group' : 'dm',
      name,
      lastSeen: Date.now(),
    };
    this._upsert(entry);
    this._persist();
  }

  private _upsert(entry: AliasEntry): void {
    const chatKey = `${entry.platform}:${entry.chatId}`;
    const prev = this.byChat.get(chatKey);
    if (prev) {
      const set = this.byAlias.get(norm(prev.alias));
      set?.delete(prev.chatId);
      if (set && set.size === 0) this.byAlias.delete(norm(prev.alias));
    }
    this.byChat.set(chatKey, entry);
    const key = norm(entry.alias);
    let set = this.byAlias.get(key);
    if (!set) {
      set = new Set();
      this.byAlias.set(key, set);
    }
    set.add(entry.chatId);
  }

  /**
   * Resolve an agent-supplied alias (`Telegram/Familia`) to its chat.
   * Matching is case-insensitive; the platform prefix is required so
   * same-named chats on different platforms never collide.
   */
  resolve(alias: string): ResolveResult {
    const trimmed = alias.trim();
    // Accept the bracketed prompt form verbatim: "[Telegram/Familia]".
    const bare = trimmed.replace(/^\[|\]$/g, '').trim();
    const chatIds = this.byAlias.get(norm(bare));
    if (!chatIds || chatIds.size === 0) {
      return { ok: false, error: `unknown alias "${bare}" — check list_aliases` };
    }
    if (chatIds.size > 1) {
      return {
        ok: false,
        error: `alias "${bare}" is ambiguous (${chatIds.size} chats share this name) — use list_aliases`,
      };
    }
    const chatId = [...chatIds][0] as string;
    const entry = [...this.byChat.values()].find(
      (e) => e.chatId === chatId && norm(e.alias) === norm(bare)
    );
    if (!entry) return { ok: false, error: `alias "${bare}" not found` };
    return { ok: true, entry };
  }

  /** Safe listing for the agent — aliases only, never raw platform ids. */
  list(): Array<Omit<AliasEntry, 'chatId'>> {
    return [...this.byChat.values()]
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map(({ chatId: _chatId, ...rest }) => rest);
  }

  private _persist(): void {
    this.store?.set('aliases', [...this.byChat.values()]);
  }
}
