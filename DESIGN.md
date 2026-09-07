# DESIGN.md

Design document for `acp-connector`. Adapted to the context of a CLI/bridge
(no UI components): documents architecture patterns, message conventions,
state machines, platform limits, and HTTP security.

## Architecture patterns

- **Thin bridge**: no agent loop, no model provider, no tools. The bridge
  only transports prompts and updates between a messaging platform and an
  arbitrary ACP agent.
- **Agent-agnostic**: `agentCmd` is an arbitrary string (e.g. `acp-agent serve`,
  `claude acp`, `gemini acp`). No hardcoded references to specific agents
  in the source code.
- **Serialized queue**: one prompt at a time per session. `session/prompt` is
  blocking, so `BridgeBot`/`DiscordBot` maintain a `queue: QueueItem[]`
  FIFO processed by `_processQueue()`, which only dispatches the next item if
  `busy === false`.
- **Config is truth**: all persistent state lives in `acp-connector.jsonc`
  (JSONC with comments and trailing commas). `RoutineManager._persist()` reloads
  the config, mutates it, and saves the whole file.
- **PlatformBot interface**: shared interface (`start`, `stop`, `enqueuePrompt`,
  `sendMessage`, `hasActivePrompt`) implemented by `BridgeBot` (Telegram) and
  `DiscordBot`. The bridge orchestrates over `PlatformBot[]`, regardless of
  the concrete platform.
- **Post-construction injection**: `MediaHandler` is created after `acp.start()`
  (to know `promptCapabilities.image`) and injected into already-constructed
  bots.
- **Permission routing**: `acp.onPermission` iterates `bots` and dispatches to
  the bot with `hasActivePrompt() === true`; if none has an active prompt, it
  cancels.
- **Cooperative shutdown**: `SIGINT`/`SIGTERM` stop HTTP, cron, bots, and ACP
  in order, then `process.exit(0)`. An empty `setInterval` keeps the process alive.

## Message conventions

### Streaming
- Batching with `STREAM_BATCH_MS = 800` ms (shared constant for TG and Discord).
- A **single** message is edited per prompt: the first chunk is sent with
  `sendMessage`, subsequent ones are updated with `editMessageText` (TG) /
  `message.edit` (Discord).
- `streamBuffer` accumulates text; `streamDirty` indicates unflushed changes;
  `streamTimer` schedules the flush.
- On `stop`, the remaining stream is flushed, then overflow.

### ACP update types
| `sessionUpdate` | Action |
|---|---|
| `agent_message_chunk` | Append to buffer (content.type === 'text') |
| `agent_message` | Replace buffer (content array or single) |
| `agent_thought_chunk` | Append only if `showThoughts=true` |
| `agent_thought` | Append only if `showThoughts=true` |
| `tool_call` | Append tool status line only if `showTools=true` |
| `tool_call_update` | Update tool status line only if `showTools=true` |
| `plan` | Render plan checklist only if `showPlan=true` |
| `current_mode_update` | Update current mode state |
| `stop` | End of update loop |

### Parse mode and fallback
- **Telegram**: `parse_mode: 'Markdown'` in send and edit. If Telegram rejects
  with a parse error (`parse` / `entity` in the message), it retries **without**
  `parse_mode` (plain text). Applies to both stream flush and overflow.
- **Discord**: plain text, no `parse_mode` in send or edit. Edit failures are
  non-fatal (silenced).

### Overflow
- When `streamBuffer.length > MAX_LEN`, excess chunks are sent as new messages
  (send), respecting the same limit and the same parse fallback.

## State patterns

Bot states (TG and Discord share the same machine):

- **Idle**: `busy=false`, `currentChatId`/`currentChannelId = null`, no active prompt.
  - Transition to **Processing** when dispatching a queue item.
- **Processing**: `busy=true`, `currentChatId`/`currentChannelId` set,
  `currentMessageId`/`currentMessage` set after first flush.
  - `for(;;)` loop consuming `acp.nextUpdate()` until `kind === 'stop'`.
  - Transition to **Idle** on completion (catch included).
- **Permission pending**: `permissionPending != null`, inline buttons sent
  (`Permission required`). Resolved via `callback_query` (TG) /
  `interactionCreate` (Discord) with `perm_allow_*` / `perm_deny_*`.
- **Error**: any exception in `prompt()` or `nextUpdate()` sends
  `Error: <msg>` to the chat/channel and returns to **Idle**.

AcpClient states:

- **Not started**: `_started=false`, `session=null`. `prompt()` throws.
- **Starting**: spawn + initialize + session load/resume/build in progress.
- **Ready**: `session` and `sessionId` set, `_sessionReady` resolved.
- **Killed**: `_killed=true`, `session.dispose()` called, process killed.
  Idempotent: second `kill()` is a no-op.

## Platform limits

| Platform | Max len | Parse mode | Edit |
|---|---|---|---|
| Telegram | 4096 (`TG_MAX_LEN`) | Markdown (fallback plain) | `editMessageText` |
| Discord | 2000 (`DISCORD_MAX_LEN`) | Plain (no parse_mode) | `message.edit` |

## Builtin commands

Commands handled before forwarding to the agent (in `_handleBuiltinCommand`):

| Command | Behavior |
|---|---|
| `/start`, `/help` | Help message with command list |
| `/stop` | If idle → `Nothing to stop.`; if busy → `acp.cancel()` + clear queue + `⏹ Stopped.` |

Commands delegated to `RoutineManager` via `onCommand`:

| Command | Subcommands |
|---|---|
| `/cron` | `list`, `add <schedule> <prompt>`, `remove <name>`, `toggle <name>`, `run <name>` |
| `/routine` | `list`, `add <name> <prompt>`, `remove <name>` |
| `/run <name>` | Execute routine by name |

## Permissions (ACP `session/request_permission`)

`_handlePermission` flow (TG and Discord):

1. If `agentCmd` contains `dangerous`, `bypass`, or `yolo` → auto-approve
   (select first `allow` option).
2. If no options → cancel.
3. If no `currentChatId`/`currentChannelId` → auto-approve (safe fallback).
4. If active channel → send inline buttons `Allow` / `Deny` with
   `callback_data`/`customId` `perm_allow_<optionId>` / `perm_deny_<optionId>`,
   and wait on a `Promise` resolved by the callback handler.
5. If sending buttons fails → auto-approve as fallback.

## Media (ContentBlocks)

`MediaHandler` converts downloaded files to ACP `ContentBlock`:

| Condition | Block type |
|---|---|
| `mimeType` starts with `image/` AND `supportsImage=true` | `image` (base64 data) |
| Any other case | `resource_link` (`file://` URI, name, mimeType) |
| Caption present | Additional `text` block at the end |

- Files saved in `uploadsDir` (default `/tmp/acp-connector-uploads`),
  created with `mkdirSync({ recursive: true })`.
- `BridgeBot` supports photo, document, sticker (webp→image), voice, audio, video.
- `DiscordBot` processes `msg.attachments` (any type).
- HTTP `/prompt` accepts `files: [{ data, mimeType, filename? }]`:
  - `image/*` → `ImageContent`; other → `ResourceLink` with `data:` URI.
  - Files without `data` are ignored (fallback to text).

## HTTP security

`HttpServer` (optional, `http.enabled`):

| Aspect | Default | Notes |
|---|---|---|
| Bind host | `127.0.0.1` | Loopback only by default |
| Port | `7780` | Configurable via `http.port` |
| Auth | optional | Bearer token via `http.auth.token` |
| Body limit | 1 MB (`DEFAULT_MAX_BODY`) | `http.maxBodySize` |
| Rate limit | 60 req/min (`DEFAULT_RATE_LIMIT`) | `http.rateLimit` |
| Forward headers | `false` | `http.forwardHeaders` |

Verified security rules:

- **Authorization never forwarded**: even with `forwardHeaders=true`,
  `authorization`, `content-length`, `content-type`, and `host` are removed
  before serializing headers to the prompt.
- **Strict auth**: only exact `Bearer <token>` (case-sensitive on scheme).
  Rejects lowercase `bearer`, `Basic`, empty token, extra spaces, overly long
  tokens (DoS → 401/431).
- **Auth applies to all routes** including `/health`.
- **Rate limit counts everything**: includes `/health` and unauthorized requests.
  60s sliding window over `_requestTimes`.
- **Path traversal**: `/prompt/../../../etc/passwd` → 404 (no FS reach).
- **Unsupported methods**: GET/PUT/DELETE on `/prompt` → 404 (not 405).
- **Flexible Content-Type**: accepts `application/json`, `text/plain`, and no
  content-type; uses raw body as prompt if not JSON with `text`.
- **Query params as context**: `[k=v, ...]` is prepended to the prompt (URL-decoded).
- **Responses always JSON** with `content-type: application/json`; errors
  include `error` field.

## Config (JSONC)

`acp-connector.jsonc` supports:

- Line comments `//` and block comments `/* */` (custom `stripJsonc`).
- Trailing commas (regex stripper `/,(\s*[}\]])/`).
- Strings with `//` inside are not stripped (state machine with `inString`).
- Legacy migration: `telegramToken` + `allowedChatIds` at root → `platforms.telegram`.
- Validation: `agentCmd` required (string); requires `platforms.telegram` or
  legacy `telegramToken`.
- `defaultConfigPath` = `cwd/acp-connector.jsonc`.

## Logging conventions

- Prefix emojis on stdout: `👤` (incoming prompt), `🤖` (response),
  `🚫` (unauthorized chat), `⏰` (cron), `🔐` (permission), `⚡` (auto-approve),
  `📄` (file saved), `🌐` (HTTP), `⏹` (stop), `👋` (help).
- `_sanitize(text, 80)` for logs: strips control chars, newlines, truncates to 80.
- Agent errors (stderr) filtered by regex
  `/\bERROR\b|\bFATAL\b|\berror:\b|\bfatal:\b|Invalid params/` and logged with `⚠️`.
