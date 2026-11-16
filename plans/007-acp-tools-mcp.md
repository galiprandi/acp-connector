# Plan 007: Unified `acp-tools` MCP — agent messaging + consolidated bridge tools

> **Status: DONE** — implemented as planned. Deviations: `send_message`
> dropped per operator decision; `reminders-api.ts` renamed to
> `bridge-api.ts` (not just extended); platform labels capitalized
> (`Telegram`/`Discord`) in prefixes and aliases; `_senderInfo` returns
> `undefined` when no real sender name exists (channel posts, minimal
> fixtures) so no prefix/alias is injected.

## Status

- **Priority**: P2 (feature)
- **Effort**: L
- **Risk**: MED (new outbound file-send path + prompt-format change; mitigated by path allowlist, operator-only tools, E2E coverage)
- **Depends on**: none
- **Category**: feature
- **Operator decisions**: single MCP named `acp-tools` absorbing existing reminder/cron tools (consolidated `action` param, not one mega-tool); identity prefix `[Platform/Chat] Name:` injected into every user prompt; agent addressing via bracket marker copied into `to=`; no `send_message` tool (YAGNI); fake agent extended into a minimal MCP client for real E2E.

## Goal

One MCP server (`acp-tools`) per bridge giving the agent:

- `send_file(path, caption?, to?)` — send a file to a chat (default: current chat)
- `list_aliases()` — list known chat aliases (never raw platform IDs)
- `reminder(action, ...)` / `cron(action, ...)` — existing tools consolidated
  under one tool per domain (`action: "create"|"list"|"cancel"|"update"`)

Plus: every user prompt reaches the agent prefixed with sender/chat identity
so it knows who is talking and where to reply.

## Current state

- `src/reminders-mcp.ts` — MCP stdio server `agent-reminders` with 8 tools
  (`reminder_create/list/cancel/update`, `cron_create/list/update/delete`),
  thin HTTP calls to loopback API.
- `src/reminders-api.ts` — loopback HTTP on 127.0.0.1 ephemeral port; no auth
  (agent is trusted); `MAX_BODY` 64KB.
- `src/bridge.ts:98-136` — starts `remindersApi`, injects `agent-reminders`
  MCP via `mcpServers` in `session/new` (env `REMINDERS_API_URL`).
- `src/base-bot.ts` — `enqueuePrompt(text, chatId, blocks, onComplete, source, onChunk)`;
  `_enqueueUserMessage(channelId, messageId, text, blocks)` for user msgs;
  `_processQueue` builds the ACP prompt.
- `src/bot.ts` / `src/discord.ts` — platform bots; TG `msg.from`/`msg.chat`,
  Discord `msg.author`/`msg.channel` carry identity already.
- `test/e2e/fake-agent.mjs` — fake ACP agent (JSON-RPC stdio), echoes prompts.

## Design

### 1. Identity prefix

New `src/identity.ts`:

```ts
interface SenderInfo { name: string; handle?: string; isGroup: boolean; chatName?: string }
formatPrefix(platform: 'telegram'|'discord', sender: SenderInfo): string
// → "[Telegram] Germán Aliprandi: " | "[Telegram/Familia] Santi: " | "[Discord/General] Germán: "
```

- DM: `[Platform] Name:` — chat IS the person.
- Group/channel: `[Platform/ChatName] SenderName:` — bracket = destination.
- The bracket content maps to alias `Platform/ChatName` (DMs use sender name).

Plumbing: `_enqueueUserMessage` gains a `sender?: SenderInfo` param; bots pass
`msg.from`/`msg.author` + chat title. `QueueItem` stores it; `_processQueue`
prepends a leading text block `[prefix] ` to the prompt (before user text;
media captions unaffected). Non-user sources (cron/http/a2a) get NO prefix —
they already carry `[source]` labels.

### 2. Alias directory — `src/aliases.ts`

```ts
class AliasDirectory {
  register(platform, chatId, kind: 'dm'|'group', displayName, senderName?)
  resolve(alias: string): { platform, chatId } | 'ambiguous' | 'not-found'
  list(): AliasEntry[]  // alias, platform, kind, name — never raw ids
}
```

- Updated on EVERY inbound message (chat title for groups, sender name for
  DMs) — self-healing on renames.
- Persisted to `.acp-connector/aliases.json` (0600) so aliases survive
  restarts; in-memory is source of truth at runtime.
- Alias format: `Platform/DisplayName` (e.g. `Telegram/Familia`,
  `Telegram/Germán Aliprandi`). Ambiguous names → error asking to disambiguate.

### 3. Loopback API — extend `reminders-api.ts` → rename `bridge-api.ts`

New endpoints (same trust model, 127.0.0.1, no auth):

- `GET /aliases` → `list()` output
- `POST /message/send` `{ to?, text }` → resolves alias (default: current
  chat = channelId of the QueueItem being processed, fallback last inbound)
- `POST /file/send` `{ to?, path, caption? }` → path allowlist check
  (`tools.allowedPaths`, default: agentCwd + uploadsDir + tmpdir), realpath
  containment, size cap ~45MB, then platform send

Current-chat tracking: bridge records `channelId` of the QueueItem being
processed (`bot.busyItem`) + last inbound chat per bot as fallback.

Env var: keep accepting `REMINDERS_API_URL`, also accept `BRIDGE_API_URL`
(new name going forward).

### 4. MCP server — `src/acp-tools.ts` (replaces `reminders-mcp.ts`)

Server name `acp-tools`. Tools:

- `send_file({ path, caption?, to? })` → POST /file/send
- `list_aliases()` → GET /aliases
- `reminder({ action: 'create'|'list'|'cancel'|'update', ... })` → existing
  endpoints, params flattened per action
- `cron({ action: 'create'|'list'|'update'|'delete', ... })` → same

`reminders-mcp.ts` deleted; `bridge.ts` injects `acp-tools` (env
`BRIDGE_API_URL`, fallback `REMINDERS_API_URL`).

### 5. Outbound file send

- `BaseBot.sendFile(chatId, absPath, caption?)` — abstract.
- TG: `bot.sendDocument(chatId, path, { caption })`; images → `sendPhoto`.
- Discord: `channel.send({ files: [path], content: caption })`.
- `resolveAlias` lives in bridge; bots expose `sendToChat(aliasOrId, ...)`.

### 6. Fake agent MCP client — `test/e2e/fake-agent.mjs`

- Capture `mcpServers` from `session/new` params.
- Minimal MCP stdio client: spawn `command args`, JSON-RPC
  `initialize` → `notifications/initialized` → `tools/call`.
- Prompt convention: `call <tool> <json-args>` → invoke tool on each MCP
  server, return result as `agent_message_chunk`.

### 7. Tests

- Unit: `aliases.test.ts` (register/resolve/ambiguous/persist),
  `identity.test.ts` (prefix formats), bridge-api file/message endpoints,
  path allowlist rejections.
- Update existing reminders-mcp tests → acp-tools tool names/actions.
- E2E: fake agent `call send_file ...` → fake TG transport receives
  `sendDocument`; prompt prefix asserted in echoed text.
- Docs: README (acp-tools section), example config (`tools` block optional),
  AGENTS.md architecture, CHANGELOG.

## STOP conditions

- ACP `session/new` mcpServers shape differs per agent — verify devin acp +
  opencode accept the renamed server (they should; it's generic).
- `sendDocument`/`sendPhoto` not available in node-telegram-bot-api version
  pinned — verify before implementing.
- QueueItem identity breaks media/caption flows — keep prefix as separate
  leading text block, never mutate user text.
