import { describe, expect, it } from 'vitest';
import { aliasDisplayName, identityPrefix } from '../src/identity.js';

describe('identityPrefix', () => {
  it('formats a DM as [Platform] Name:', () => {
    expect(identityPrefix('telegram', { name: 'Germán Aliprandi', isGroup: false })).toBe(
      '[Telegram] Germán Aliprandi: '
    );
  });

  it('formats a group as [Platform/Chat] Sender:', () => {
    expect(
      identityPrefix('discord', {
        name: 'Santi',
        isGroup: true,
        chatName: 'Familia',
      })
    ).toBe('[Discord/Familia] Santi: ');
  });

  it('falls back to platform-only label for groups without a title', () => {
    expect(identityPrefix('telegram', { name: 'Santi', isGroup: true })).toBe('[Telegram] Santi: ');
  });
});

describe('aliasDisplayName', () => {
  it('uses the sender name for DMs', () => {
    expect(aliasDisplayName({ name: 'Germán', isGroup: false })).toBe('Germán');
  });

  it('uses the chat title for groups', () => {
    expect(aliasDisplayName({ name: 'Santi', isGroup: true, chatName: 'Familia' })).toBe('Familia');
  });
});
