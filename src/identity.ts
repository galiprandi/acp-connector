/**
 * Sender/chat identity injected into user prompts so the agent knows who
 * is talking and where replies go.
 *
 * Prompt prefix format:
 *   DM:     `[Telegram] Germán Aliprandi: <message>`
 *   Group:  `[Telegram/Familia] Santi: <message>`
 *
 * The bracketed label maps to the alias `Platform/Name` used by the
 * `send_file` tool's `to` parameter — the agent copies it verbatim.
 */

export interface SenderInfo {
  /** Display name of the person who sent the message. */
  name: string;
  /** True when the chat has multiple members (group/channel, not DM). */
  isGroup: boolean;
  /** Group/channel title — the destination name in the prefix + alias. */
  chatName?: string;
}

/** Display label for a platform id: 'telegram' → 'Telegram'. */
export function platformLabel(platform: string): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * Build the identity prefix prepended to user prompts.
 * Direct chats show only the platform; groups/channels add `/ChatName`
 * so the agent can tell destination (bracket) from speaker (after it).
 */
export function identityPrefix(platform: string, sender: SenderInfo): string {
  const label = sender.isGroup && sender.chatName ? `${platform}/${sender.chatName}` : platform;
  return `[${platformLabel(label)}] ${sender.name}: `;
}

/**
 * Display name used for the chat alias: group/channel title for groups,
 * sender name for DMs (the chat IS the person).
 */
export function aliasDisplayName(sender: SenderInfo): string {
  return sender.isGroup && sender.chatName ? sender.chatName : sender.name;
}
