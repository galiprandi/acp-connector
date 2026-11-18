# Configuration reference

← Back to [README](../README.md)

All configuration lives in a single `acp-connector.jsonc` file in your working directory. The setup wizard creates it for you, or you can write it manually.

See [`acp-connector.example.jsonc`](../acp-connector.example.jsonc) for the full reference.

## Core options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `agentCmd` | `string` | yes | — | Command to launch the ACP agent (e.g. `"devin acp"`) |
| `agentCwd` | `string` | no | `cwd` | Working directory for the agent subprocess |
| `platforms` | `Platforms` | yes | — | Platform configs (Telegram and/or Discord) |
| `platforms.telegram` | `object` | no | — | `{ token, allowedChatIds, allowedUserIds? }` — Telegram config |
| `platforms.discord` | `object` | no | — | `{ token, allowedChannelIds, allowedUserIds? }` — Discord config |
| `restoreLastSession` | `boolean` | no | `true` | Resume the last session on startup. The bridge keeps the active session id in `.acp-connector/state.json` automatically; set `false` for manual control |
| `sessionMode` | `string` | no | — | Initial session mode (e.g. `"bypass"` for Devin's auto-approve-all) — see [Initial session mode](commands.md#initial-session-mode) |
| `sessionConfigPath` | `string` | no | — | Path to MCP/session config JSONC — see [MCP servers](#mcp-servers) |
| `showThoughts` | `boolean` | no | `false` | Forward agent thoughts to chat |
| `showTools` | `boolean` | no | `true` | Show tool calls (e.g. "Read file", "Run tests") in chat. Set to `false` when only the final answer matters |
| `showPlan` | `boolean` | no | `true` | Show agent plan/checklist in chat |
| `streaming` | `boolean` | no | `true` | Stream responses with live message edits |
| `echoInjectedPrompts` | `boolean` | no | `true` | Echo prompts injected via jobs, HTTP or A2A into the chat with a source label (`⏰ [job]`/`[agent-job]`, `🌐 [http]`, `🔁 [a2a]`) so you can see what triggered the agent's response |
| `logLevel` | `string` | no | `"info"` | Bridge log verbosity: `"error"` (errors only) \| `"warn"` \| `"info"` \| `"debug"`. Does not affect the agent subprocess's own stderr output |
| `logPreviewLength` | `number` | no | `150` | Max characters of `👤`/`🤖` chat previews written to the log (min `20`; longer text is cut with `…`) |
| `timezone` | `string` | no | — | IANA timezone for absolute job times without an explicit zone (`"mañana 18hs"`, `"tomorrow 10am"`, `at` values) — e.g. `"America/Argentina/Tucuman"`. **Required for those**: unset means they're rejected rather than guessed against the host's zone. Pure durations (`"30m"`, `"in 45 minutes"`) and explicit zones (`Z`, `±HH:MM`) don't need it. Written automatically by `acp-connector setup` |
| `cron` | `CronJob[]` | no | — | **Deprecated** — migrated into `state.json` jobs on first boot |
| `routines` | `Routine[]` | no | — | **Deprecated** — migrated into `state.json` jobs (manual) on first boot |
| `sessionId` | `string` | no | — | **Deprecated** — migrated into `state.json` on first boot |
| `http` | `HttpConfig` | no | off | HTTP server config (see [HTTP API](#http-api)) |
| `media` | `MediaConfig` | no | off | Media handling config (see [Media handling](#media-handling)) |
| `tools` | `ToolsConfig` | no | off | `acp-tools` MCP tuning: `allowedPaths` (extra dirs the agent may `send_file` from — agent cwd, uploads dir and tmpdir are always allowed) and `maxFileSizeMb` (default 45) |
| `transcription` | `object` | no | on | Voice-note transcription tuning (see [Voice transcription](#voice-transcription)) |
| `a2a` | `object` | no | off | A2A network config — see [A2A agent network](a2a.md) |

> **Backward compat:** `telegramToken` and `allowedChatIds` at the root level still work but are deprecated. Migrate to `platforms.telegram`.

## Jobs

Everything that fires a prompt later — one-shot reminders, recurring schedules, manual triggers — lives in a single job list inside `.acp-connector/state.json`. There is no config-side job list anymore: jobs are created and managed at runtime.

A job is `{ prompt, trigger, name?, enabled, managed }` where `trigger` is one of:

| Trigger | Fires |
|---|---|
| `{ kind: "once", at }` | Once at an absolute time (ISO) |
| `{ kind: "cron", expr }` | Recurring 5-field cron expression |
| `{ kind: "manual" }` | Never on its own — triggered by name via `/jobs run` or the agent |

You create and manage them with `/jobs` chat commands (see [Chat commands](commands.md#jobs)); the agent manages its own via the `jobs` MCP tool. `managed: "agent"` jobs are capped (50) and fire as remote content — see [acp-tools](acp-tools.md).

On first boot after upgrading, legacy state migrates automatically: `config.cron[]` → cron jobs, `config.routines[]` → manual jobs, `reminders.json` → once jobs, `aliases.json`/`network.json`/`config.sessionId` → their `state.json` sections. Legacy files are renamed `*.migrated` (never deleted) and the migrated config fields are stripped from `acp-connector.jsonc`.

## HTTP API

Optional. Enable in config:

```jsonc
{
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 7780,
    "auth": {
      "token": "your-secret"
    },
    "forwardHeaders": false,
    "maxBodySize": 1048576,
    "rateLimit": 60
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Start the HTTP server |
| `host` | `string` | `"127.0.0.1"` | Bind address (use `"0.0.0.0"` for LAN access) |
| `port` | `number` | `7780` | Port to listen on |
| `auth.token` | `string` | `null` | Bearer token for auth (**required** for non-loopback hosts — the server refuses to start with an external `host` and no token) |
| `commands` | `boolean` | `false` | Allow `/commands` (e.g. `/a2a`, `/sessions`, `/jobs`) to be run via `POST /prompt` — default `false`: prompt text sent over HTTP is agent input, never bridge administration |
| `callbackAllow` | `string[]` | `[]` | Hostnames accepted as `callbackUrl` targets besides public ones (loopback/private hosts are rejected by default) |
| `forwardHeaders` | `boolean` | `false` | Forward request headers to agent (`Authorization` always stripped) |
| `maxBodySize` | `number` | `1048576` | Max body size in bytes (1MB) |
| `rateLimit` | `number` | `60` | Max requests per minute |

### `GET /health`

```bash
curl http://localhost:7780/health
```

```json
{ "status": "ok", "agent": true, "session": "abc-123" }
```

### `POST /prompt`

Send a prompt with structured JSON:

```bash
curl -X POST http://localhost:7780/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "fix the failing tests", "chatId": 123456789}'
```

Or send a raw body with query params as context:

```bash
curl -X POST "http://localhost:7780/prompt?origin=outlook&from=boss" \
  -H "Content-Type: application/json" \
  -d '{"from": "boss@company.com", "subject": "URGENT"}'
```

The agent receives: `[origin=outlook, from=boss] {"from": "boss@company.com", "subject": "URGENT"}`

> `POST /prompt` sends **agent input**. To run bridge commands (`/a2a`, `/sessions`, ...) over HTTP set `http.commands: true` in the config. A `chatId` in the body is only honored when it is in the platform `allowedChatIds`.

With auth:

```bash
curl -X POST http://localhost:7780/prompt \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"text": "hello"}'
```

```json
{ "ok": true }
```

The prompt enters the same queue as Telegram messages. If `chatId` is omitted, the first allowed chat ID is used.

#### Sending files via `/prompt`

Include `files` as an array of base64-encoded objects:

```bash
curl -X POST http://localhost:7780/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "text": "analiza esta imagen",
    "files": [
      { "data": "iVBORw0KGgo...", "mimeType": "image/png", "filename": "screenshot.png" }
    ]
  }'
```

- **Images** (`image/*`) → sent as `ImageContent` base64 blocks
- **Other files** → sent as `ResourceLink` with data URI
- Multiple files supported — text is appended as a final text block
- Backward compatible: omit `files` for text-only prompts

#### Webhook callback

Include `callback_url` (or `callbackUrl`) to receive the agent's response asynchronously:

```bash
curl -X POST http://localhost:7780/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "text": "fix the failing tests",
    "callback_url": "https://your-ci.com/webhook"
  }'
```

The bridge returns `200 {ok:true}` immediately. When the agent finishes, the bridge POSTs to the callback URL:

```json
{ "response": "I fixed the tests by...", "error": null }
```

If the prompt fails, `error` contains the error message and `response` is empty. The callback is fire-and-forget — failures are logged but not retried.

## Media handling

Send photos, documents, stickers, voice messages, videos, or files to the bot and they'll be forwarded to the agent:

- **Photos** + agent supports `image` capability → sent as base64 `ImageContent` (agent "sees" the image)
- **Any file** (or agent without `image` capability) → sent as `ResourceLink` with `file://` URI (agent reads the file from disk)
- **Voice notes** (Telegram `voice`, Discord voice messages) → transcribed to plain text locally via [audio-transcription](https://www.npmjs.com/package/audio-transcription) (sherpa-onnx Parakeet TDT, on-device) and sent to the agent as if typed — see [Voice transcription](#voice-transcription) below
- Files are saved to `media.uploadsDir` (default: `/tmp/acp-connector-uploads`)
- Captions are included as text alongside the media
- Downloads retry transient failures (3 attempts, linear backoff); HTTP 4xx fails fast. On final failure the chat shows the underlying cause (e.g. `fetch failed: connect ECONNRESET [ECONNRESET]`)

```jsonc
{
  "media": {
    "uploadsDir": "/tmp/acp-connector-uploads"
  }
}
```

## Voice transcription

Voice notes are transcribed **on the bridge machine** — no audio ever leaves
your server, no API keys needed. Powered by the
[`audio-transcription`](https://github.com/galiprandi/audio-transcription)
package (sherpa-onnx NeMo Parakeet TDT v3, 25 European languages incl.
Spanish, ~3x faster than real time on a modern CPU).

- **First voice note** lazily installs the runtime (`sherpa-onnx-node` +
  `ffmpeg-static`, ~150MB) and downloads model weights (~490MB) into a shared
  per-user cache (`~/.cache/audio-transcription`). All acp-connector
  instances on the machine share it; concurrent installs/downloads are
  serialized with lock files. Expect minutes on first use — a 🤔/🎧 reaction
  shows transcription is in progress.
- The agent receives the transcript as **plain text** — it can't tell (and
  doesn't need to) that the message was a voice note.
- After transcription the audio file is **deleted** (success and failure).
  Set `deleteAfterTranscribe: false` to keep successful transcriptions.
- On failure the user gets `🎙️ Transcription failed — please resend the voice
  note.` and nothing reaches the agent.
- Only **voice notes** are transcribed — audio file attachments (mp3, m4a)
  still go through as `resource_link` files.
- Decoding is serialized machine-wide (one transcription at a time across
  all bridges on the host) so CPUs are never saturated; `numThreads` defaults
  to `min(8, CPU count)`.

```jsonc
{
  "transcription": {
    "enabled": true,               // default: true — set false for legacy resource_link behavior
    "deleteAfterTranscribe": true, // default: true
    "cacheDir": null,              // override ~/.cache/audio-transcription
    "numThreads": null,            // e.g. 2 on weak/shared machines
    "lockTimeoutMs": null          // default 10min
  }
}
```

## MCP servers

The bridge passes `sessionConfigPath` to the agent unchanged. MCP servers (stdio, HTTP, SSE, or ACP) are configured in that file — the bridge doesn't interpret them.

### Stdio

```jsonc
{
  "mcpServers": [
    {
      "type": "stdio",
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "env": []
    }
  ]
}
```

### HTTP

Requires the agent to advertise `mcp.http` capability.

```jsonc
{
  "mcpServers": [
    {
      "type": "http",
      "name": "my-api",
      "url": "https://api.example.com/mcp",
      "headers": [
        { "name": "Authorization", "value": "Bearer your-token" }
      ]
    }
  ]
}
```

### SSE

Requires the agent to advertise `mcp.sse` capability.

```jsonc
{
  "mcpServers": [
    {
      "type": "sse",
      "name": "events",
      "url": "https://api.example.com/sse",
      "headers": []
    }
  ]
}
```

### Mixed

You can combine multiple transports in the same config:

```jsonc
{
  "mcpServers": [
    { "type": "stdio", "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": [] },
    { "type": "http", "name": "api", "url": "https://api.example.com/mcp", "headers": [] }
  ]
}
```

> The bridge does not validate MCP capabilities — if the agent doesn't support a transport, it will reject the session. Check your agent's `mcpCapabilities` in its docs.

## Security configuration (0.13.0)

v0.13.0 is a security release — see the [CHANGELOG migration table](../CHANGELOG.md) for the breaking-change summary. The relevant knobs:

- **A2A peer auth** — `a2a.secure: true` makes HMAC peer signatures mandatory (**default on**; set `a2a.secure: false` only for mixed-version meshes during migration). Details: [Peer authentication](a2a.md#peer-authentication).
- **HTTP API** — non-loopback `http.host` requires `http.auth.token` (refuses to start otherwise); `http.commands: true` allows `/` bridge commands via `POST /prompt` (default: agent input only); `http.callbackAllow` whitelists internal `callbackUrl` hosts.
- **Group permissions** — `platforms.*.allowedUserIds` gates who can approve agent permissions / reconnect inside groups (private chats and DMs always allowed).
- **Agent jobs** — agent-created jobs are remote content: `/`-prompts never run bridge commands.
- **Audit backlog** — full findings and statuses live in [`security-audit-2026-10-21.md`](security-audit-2026-10-21.md); remediation plans in [`plans/`](../plans/README.md).

### Defense-in-depth hardening

Non-breaking hardening on top of the trust-model fixes:

- **File permissions** — `acp-connector.jsonc`, `.acp-connector/*` state (`state.json`, `audit.log`, `instances.json`) and media uploads are written `0600` inside `0700` directories; pre-existing loose permissions are tightened on the next write. Upload filenames sanitize the extension to a safe charset and are created with `O_EXCL`, so a pre-planted symlink is never followed.
- **Resource caps** — the prompt queue holds at most 100 items (chat messages and injected sources alike; excess is dropped with a warning), A2A request bodies are capped at 1 MiB (`413`), and pending A2A join requests are capped at 100.
- **Permission buttons** — `perm_*` buttons are bound to the message that carried the request; stale buttons from older prompts can no longer resolve the current permission request.
- **Error hygiene** — internal failures return a generic `internal error` to HTTP/A2A clients (details stay in logs and the audit trail), and HTTP bearer auth uses a constant-time comparison.
- **Delegation chains** — the A2A delegation chain is propagated across agent-initiated delegations, so multi-hop loops are rejected at `maxDepth` (default 3) instead of only direct A→B→A cycles.
- **Setup hardening** — the `assistant-setup` wizard downloads the template tarball pinned to an exact commit with SHA-256 verification, reads bot tokens without terminal echo, never interpolates `USER` into `loginctl` unsanitized, and refuses to overwrite a foreign `~/.local/bin/node`. Wizard binaries ship as GitHub release assets only — they are excluded from the npm tarball.
