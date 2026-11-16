import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AliasDirectory } from '../src/aliases.js';
import type { SenderInfo } from '../src/identity.js';

const dm = (name: string): SenderInfo => ({ name, isGroup: false });
const grp = (chatName: string, sender: string): SenderInfo => ({
  name: sender,
  isGroup: true,
  chatName,
});

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('AliasDirectory', () => {
  it('registers a DM alias from the sender name', () => {
    const d = new AliasDirectory();
    d.register('telegram', 123, dm('Germán Aliprandi'));
    const r = d.resolve('Telegram/Germán Aliprandi');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.chatId).toBe('123');
      expect(r.entry.kind).toBe('dm');
      expect(r.entry.platform).toBe('telegram');
    }
  });

  it('registers a group alias from the chat title, not the sender', () => {
    const d = new AliasDirectory();
    d.register('telegram', -100, grp('Familia', 'Santi'));
    const r = d.resolve('Telegram/Familia');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.chatId).toBe('-100');
    // The sender name must NOT become an alias for the group chat.
    expect(d.resolve('Telegram/Santi').ok).toBe(false);
  });

  it('resolves case-insensitively and accepts the bracketed prompt form', () => {
    const d = new AliasDirectory();
    d.register('discord', '999', grp('General', 'Germán'));
    expect(d.resolve('discord/general').ok).toBe(true);
    expect(d.resolve('[Discord/General]').ok).toBe(true);
  });

  it('keeps same-named chats on different platforms distinct', () => {
    const d = new AliasDirectory();
    d.register('telegram', 1, grp('Familia', 'A'));
    d.register('discord', '2', grp('Familia', 'B'));
    const tg = d.resolve('Telegram/Familia');
    const dc = d.resolve('Discord/Familia');
    expect(tg.ok && tg.entry.chatId).toBe('1');
    expect(dc.ok && dc.entry.chatId).toBe('2');
  });

  it('reports ambiguity when two chats share an alias', () => {
    const d = new AliasDirectory();
    d.register('telegram', 1, grp('Familia', 'A'));
    d.register('telegram', 2, grp('Familia', 'B'));
    const r = d.resolve('Telegram/Familia');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ambiguous');
  });

  it('updates the alias when a chat is renamed (same chatId, new name)', () => {
    const d = new AliasDirectory();
    d.register('telegram', 1, dm('Old Name'));
    d.register('telegram', 1, dm('New Name'));
    expect(d.resolve('Telegram/Old Name').ok).toBe(false);
    const r = d.resolve('Telegram/New Name');
    expect(r.ok && r.entry.chatId).toBe('1');
  });

  it('lists aliases without exposing raw chat ids', () => {
    const d = new AliasDirectory();
    d.register('telegram', 12345, dm('Germán'));
    const list = d.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.alias).toBe('Telegram/Germán');
    expect(list[0]).not.toHaveProperty('chatId');
  });

  it('persists and reloads aliases across restarts', () => {
    dir = mkdtempSync(join(tmpdir(), 'acp-alias-'));
    const store = join(dir, 'aliases.json');
    const d1 = new AliasDirectory(store);
    d1.register('telegram', 777, dm('Persisted User'));

    const d2 = new AliasDirectory(store);
    const r = d2.resolve('Telegram/Persisted User');
    expect(r.ok && r.entry.chatId).toBe('777');
  });
});
