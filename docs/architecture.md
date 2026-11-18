# Architecture

← Back to [README](../README.md)

## How it works

```
┌──────────┐     ┌─────────────────┐     ┌─────────────┐
│ Telegram │────▶│                 │     │             │
│          │     │  acp-connector  │────▶│  ACP Agent  │
│  (you)   │◀────│   (bridge)      │     │ (any agent) │
│          │     │                 │◀────│             │
└──────────┘     └─────────────────┘     └─────────────┘
                          ▲
                          │
                 ┌────────┴────────┐
                 │                 │
            ┌────┴────┐      ┌─────┴───┐
            │  Cron   │      │  HTTP   │
            │ (jobs)  │      │  (API)  │
            └─────────┘      └─────────┘
```

1. **Telegram** messages are validated against an allowlist and enqueued
2. **Cron** jobs inject prompts on a schedule into the same queue
3. **HTTP** `POST /prompt` injects prompts programmatically into the same queue
4. The bridge processes the queue **one prompt at a time** (ACP is blocking)
5. Agent responses **stream back** to Telegram with live message edits
6. **Permissions** are forwarded as inline buttons (or auto-approved)

When a prompt arrives while the bot is busy, the bridge reacts to the user's message with a queued indicator (😴 on Telegram, ⏳ on Discord) and clears it once the prompt starts processing.

Replying to a message (Telegram `reply_to_message`, Discord `msg.reference`) injects the quoted text as context: the prompt is forwarded as `[in reply to @user: "quoted text"] your prompt`, truncated at 300 chars. Works on both text and media captions.

## Permissions

ACP agents may request permission before executing certain actions (file writes, shell commands, etc.). The bridge handles this in two ways:

1. **Auto-approve**: If your `agentCmd` includes `dangerous`, `bypass`, or `yolo`, all permissions are auto-approved silently.
2. **Inline buttons**: Otherwise, the permission request is forwarded to Telegram/Discord with "Allow" / "Deny" buttons. Tap to approve or deny.

**Who can tap the buttons:** private chats and DMs always work — they have a single human member. Inside group chats / guild channels, only users listed in `platforms.telegram.allowedUserIds` / `platforms.discord.allowedUserIds` can approve permissions or use the reconnect button; everyone else gets a "Not authorized" notice. If the list is empty, **nobody** in a group can approve permissions — configure it if you use groups:

```jsonc
{
  "platforms": {
    "telegram": { "token": "...", "allowedChatIds": [123], "allowedUserIds": [456] }
  }
}
```

Find your Telegram user ID via [@userinfobot](https://t.me/userinfobot); Discord user IDs are under *User Settings → Advanced → Developer Mode* (right-click a user → Copy User ID).

## Session persistence

By default (`restoreLastSession: true`) the bridge **automatically resumes your last session across restarts**: every time the active session changes — startup, `/sessions new`, `/sessions <n|id>`, agent restart — the bridge writes the session id to `state.sessionId` in `.acp-connector/state.json`, and on the next start it calls `session/resume` or `session/load` (depending on agent capabilities).

If the stored session can't be resumed (deleted, expired, or the agent doesn't support resume/load — or doesn't support resume at all), the bridge logs a warning and starts a fresh session — it never fails to boot because of this.

Set `"restoreLastSession": false` to opt out: nothing is persisted and every start creates a fresh session. (The deprecated `sessionId` config field is honored once during migration, then stripped.)

```jsonc
{
  "restoreLastSession": false // default: true
}
```

## Status feedback

- **Typing indicator**: while the agent works on a prompt, the bridge sends a `typing` chat action every ~4s (Telegram `sendChatAction`, Discord `sendTyping`) — visible even when `showThoughts`/`showTools` are off.
- **Long messages**: replies that exceed the platform limit (4096 chars on Telegram, 2000 on Discord) are split into multiple messages at paragraph → line → word boundaries (hard cuts only when no boundary fits). Continuation parts are sent as replies to the first part so they read as a single message.
- **Agent crash detection**: if the agent process exits unexpectedly, all allowed chats get a notification with a **🔄 Reconnect** inline button. Tapping it re-spawns `agentCmd` and resumes the previous session when possible (via `session/resume`/`session/load`), falling back to a fresh session if resume fails.

## Runtime files

- `.acp-connector/state.json` — **all** runtime state (gitignored, `0600`):
  active session id, chat aliases, jobs, A2A peers/statuses, seen task ids.
  Config is intent; this file is reality. On first boot after upgrading,
  legacy `aliases.json`/`reminders.json`/`network.json` and the config's
  `cron`/`routines`/`sessionId` fields migrate into it automatically
  (legacy files become `*.migrated`).
