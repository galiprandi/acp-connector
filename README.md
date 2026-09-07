# acp-connector

> 🔌 Thin bridge between Telegram/Discord and any ACP-compatible coding agent.

<div align="center">
  <p>
    <a href="https://www.npmjs.com/package/acp-connector">
      <img src="https://img.shields.io/npm/v/acp-connector?style=for-the-badge&logo=npm&color=CB3837" alt="NPM Version"/>
    </a>
    <a href="https://github.com/galiprandi/acp-connector">
      <img src="https://img.shields.io/github/stars/galiprandi/acp-connector?style=for-the-badge&logo=github&color=181717" alt="GitHub Stars"/>
    </a>
    <a href="https://github.com/galiprandi/acp-connector/actions">
      <img src="https://img.shields.io/github/actions/workflow/status/galiprandi/acp-connector/ci.yml?style=for-the-badge&logo=githubactions&color=2088FF" alt="CI Status"/>
    </a>
    <a href="https://github.com/galiprandi/acp-connector/blob/main/LICENSE">
      <img src="https://img.shields.io/npm/l/acp-connector?style=for-the-badge&color=blue" alt="License"/>
    </a>
  </p>
</div>

## 🧠 Overview

**acp-connector** is a lightweight, agent-agnostic bridge that connects [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) compatible coding agents to Telegram and Discord. It forwards your messages to the agent and streams responses back — no terminal required.

The bridge is intentionally thin. It doesn't implement its own agent loop, model provider, or tool ecosystem. It launches your agent, passes prompts through, and relays responses back. That's it.

**Key features:**
- 🤖 Works with any ACP agent (Devin, Claude Code, Codex, Gemini CLI, OpenCode, etc.)
- 💬 Telegram and Discord as messaging interfaces with streaming responses
- ⏰ Cron scheduler for recurring prompts
- 🔁 Routines for reusable named prompts
- 🌐 Optional HTTP API for programmatic access
- 🔐 Bearer token auth, rate limiting, body size limits
- 🧠 Agent thoughts forwarding (optional)
- 📋 Permission requests as inline buttons

***

## 🚀 Installation

```bash
# Run directly with npx (no install needed)
npx acp-connector setup

# Or install globally
npm install -g acp-connector
# or
pnpm add -g acp-connector
# or
yarn global add acp-connector
```

Then start the bridge:

```bash
acp-connector
```

***

## ⚡ Quick start

```bash
# 1. Create a Telegram bot via @BotFather, get the token
# 2. Run the setup wizard
npx acp-connector setup

# 3. Start the bridge
npx acp-connector
```

Send a message to your bot on Telegram. Your agent will respond. That's it.

***

## 📚 Table of Contents

- [Overview](#-overview)
- [Installation](#-installation)
- [Quick start](#-quick-start)
- [How it works](#-how-it-works)
- [Configuration](#-configuration)
  - [Cron jobs](#cron-jobs)
  - [Routines](#routines)
  - [HTTP API](#http-api)
- [Supported agents](#-supported-agents)
- [Telegram commands](#-telegram-commands)
- [Permissions](#-permissions)
- [Session persistence](#-session-persistence)
- [Self-hosting](#-self-hosting)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

***

## 🏗 How it works

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
            ┌────┴────┐      ┌────┴────┐
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

***

## ⚙️ Configuration

All configuration lives in a single `acp-connector.jsonc` file in your working directory. The setup wizard creates it for you, or you can write it manually.

See [`acp-connector.example.jsonc`](acp-connector.example.jsonc) for the full reference.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `agentCmd` | `string` | yes | — | Command to launch the ACP agent (e.g. `"devin acp"`) |
| `agentCwd` | `string` | no | `cwd` | Working directory for the agent subprocess |
| `platforms` | `Platforms` | yes | — | Platform configs (Telegram and/or Discord) |
| `platforms.telegram` | `object` | no | — | `{ token, allowedChatIds }` — Telegram config |
| `platforms.discord` | `object` | no | — | `{ token, allowedChannelIds }` — Discord config |
| `sessionId` | `string` | no | — | ACP session ID to load/resume (omit to create new) |
| `sessionMode` | `string` | no | — | Initial session mode (e.g. `"bypass"` for Devin's auto-approve-all) |
| `sessionConfigPath` | `string` | no | — | Path to MCP/session config JSONC |
| `showThoughts` | `boolean` | no | `false` | Forward agent thoughts to chat |
| `showTools` | `boolean` | no | `true` | Show tool calls (e.g. "Read file", "Run tests") in chat. Set to `false` when only the final answer matters |
| `showPlan` | `boolean` | no | `true` | Show agent plan/checklist in chat |
| `streaming` | `boolean` | no | `true` | Stream responses with live message edits |
| `logLevel` | `string` | no | `"info"` | `"error"` \| `"info"` \| `"debug"` |
| `cron` | `CronJob[]` | no | `[]` | Scheduled jobs (see below) |
| `routines` | `Routine[]` | no | `[]` | Named reusable prompts |
| `http` | `HttpConfig` | no | off | HTTP server config (see below) |
| `media` | `MediaConfig` | no | off | Media handling config (see below) |

> **Backward compat:** `telegramToken` and `allowedChatIds` at the root level still work but are deprecated. Migrate to `platforms.telegram`.

### Cron jobs

Schedule prompts to run automatically. Configure in `acp-connector.jsonc` or manage via Telegram commands.

```jsonc
{
  "cron": [
    {
      "name": "daily-briefing",
      "schedule": "0 9 * * *",
      "prompt": "summarize today's calendar and unread emails",
      "chatId": 123456789
    }
  ]
}
```

Or from Telegram:

```
/cron add 0 9 * * * summarize today's calendar and unread emails
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique job name |
| `schedule` | `string` | yes | Cron expression (e.g. `"0 9 * * *"`) |
| `prompt` | `string` | yes | Prompt to send to the agent |
| `chatId` | `number` | no | Chat to send the response to (default: first allowed) |
| `enabled` | `boolean` | no | `true` (set `false` to pause) |

All changes persist to `acp-connector.jsonc` automatically.

### Routines

Named reusable prompts. Define them in config or create via Telegram.

```jsonc
{
  "routines": [
    { "name": "briefing", "prompt": "summarize today's calendar and unread emails" },
    { "name": "review", "prompt": "review the latest PRs on my repos" }
  ]
}
```

Run from Telegram:

```
/run briefing
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique routine name |
| `prompt` | `string` | Prompt text |

### HTTP API

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
| `auth.token` | `string` | `null` | Bearer token for auth (optional) |
| `forwardHeaders` | `boolean` | `false` | Forward request headers to agent (`Authorization` always stripped) |
| `maxBodySize` | `number` | `1048576` | Max body size in bytes (1MB) |
| `rateLimit` | `number` | `60` | Max requests per minute |

#### `GET /health`

```bash
curl http://localhost:7780/health
```

```json
{ "status": "ok", "agent": true, "session": "abc-123" }
```

#### `POST /prompt`

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

##### Sending files via `/prompt`

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

##### Webhook callback

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

***

## 🤖 Supported agents

Any agent that implements the [Agent Client Protocol](https://agentclientprotocol.com/) works. Configure it via `agentCmd`:

| Agent | Example `agentCmd` |
|---|---|
| [Devin](https://devin.ai) | `devin acp` |
| [Claude Code](https://claude.ai/code) | `claude acp` |
| [Codex](https://openai.com/codex) | `codex acp` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini acp` |
| [OpenCode](https://github.com/sst/opencode) | `opencode acp` |
| Any ACP agent | `<your-agent> acp` |

***

### Media handling

Send photos, documents, stickers, or files to the bot and they'll be forwarded to the agent:

- **Photos** + agent supports `image` capability → sent as base64 `ImageContent` (agent "sees" the image)
- **Any file** (or agent without `image` capability) → sent as `ResourceLink` with `file://` URI (agent reads the file from disk)
- Files are saved to `media.uploadsDir` (default: `/tmp/acp-connector-uploads`)
- Captions are included as text alongside the media

```jsonc
{
  "media": {
    "uploadsDir": "/tmp/acp-connector-uploads"
  }
}
```

## 💬 Chat commands

Both Telegram and Discord support these commands:

The bridge intercepts these commands before forwarding to the agent:

### Task control

| Command | Description |
|---|---|
| `/stop` | Cancel the current task (sends `session/cancel` to the agent) |

### Session management

| Command | Description |
|---|---|
| `/new` | Start a fresh session (clears accumulated context) |
| `/sessions` | List available sessions (requires agent `session/list` capability) |
| `/session <id>` | Switch to an existing session (uses `session/resume` or `session/load`) |
| `/delete <id>` | Delete a session (requires agent `session/delete` capability) |
| `/mode` | List available session modes reported by the agent |
| `/mode <id>` | Switch session mode (e.g. `/mode bypass` for Devin's auto-approve-all) |

`/new` and `/session` are refused while the agent is busy — use `/stop` first. `/sessions` gracefully degrades with an error message if the agent doesn't support `session/list`. `/delete` cannot delete the active session (use `/new` first). `/mode` reports "No session modes available" if the agent doesn't expose modes.

#### Initial session mode

Set `sessionMode` in the config to apply a mode automatically when a session is created or loaded:

```jsonc
{
  "agentCmd": "devin acp",
  "sessionMode": "bypass"
}
```

This calls `session/set_mode` after `session/new`, `session/load`, or `session/resume`. The mode ID is agent-specific — Devin supports `accept-edits`, `smart`, `ask`, `plan`, and `bypass`. Other agents may expose different modes.

### Cron management

| Command | Description |
|---|---|
| `/cron list` | List all cron jobs |
| `/cron add <schedule> <prompt>` | Add a new cron job |
| `/cron remove <name>` | Remove a cron job |
| `/cron toggle <name>` | Pause/activate a job |
| `/cron run <name>` | Run a job immediately |

### Routine management

| Command | Description |
|---|---|
| `/routine list` | List all routines |
| `/routine add <name> <prompt>` | Add a reusable prompt |
| `/routine remove <name>` | Remove a routine |

### Execution

| Command | Description |
|---|---|
| `/run <name>` | Execute a routine by name |
| `/start` | Show welcome message with command list |
| `/help` | Show welcome message with command list |

Any other message (including unknown `/commands`) is forwarded directly to the agent.

`/stop` cancels the in-progress prompt turn and clears the pending queue. The agent receives a `session/cancel` notification and should respond with a `cancelled` stop reason.

***

## 🔐 Permissions

ACP agents may request permission before executing certain actions (file writes, shell commands, etc.). The bridge handles this in two ways:

1. **Auto-approve**: If your `agentCmd` includes `dangerous`, `bypass`, or `yolo`, all permissions are auto-approved silently.
2. **Inline buttons**: Otherwise, the permission request is forwarded to Telegram with "Permitir" / "Denegar" buttons. Tap to approve or deny.

***

## 💾 Session persistence

To resume a session across restarts, set `sessionId` in your config:

```jsonc
{
  "sessionId": "your-session-id"
}
```

The bridge will call `session/load` or `session/resume` (depending on agent capabilities) on startup. Omit this field to create a new session each time.

***

## 🖥 Self-hosting

### systemd

```ini
[Unit]
Description=acp-connector
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/npx acp-connector
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### pm2

```bash
pm2 start npx --name acp-connector -- acp-connector
pm2 save
pm2 startup
```

***

## 🐛 Troubleshooting

### `Conflict: terminated by other getUpdates request`

Another bot instance is running with the same token. Kill it:

```bash
pkill -f acp-connector
```

### Agent doesn't respond

1. Check that `agentCmd` launches your agent correctly: run it manually
2. Check the bridge console for errors
3. Ensure your chat ID is in `allowedChatIds`

## 🔌 MCP servers

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

### MCP servers not loading

If you configured `sessionConfigPath`, verify the file exists and is valid JSONC. The bridge logs errors reading it but doesn't crash.

### Telegram rate limits

The bridge batches stream edits (800ms) to avoid rate limits. If you still hit limits, disable streaming (`"streaming": false`) to send one message per response instead.

***

## 🤝 Contributing

See [AGENTS.md](AGENTS.md) for development setup, commit conventions, and release process.

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint
- **Linting**: [Biome](https://biomejs.dev/)
- **Tests**: [Vitest](https://vitest.dev/) — `pnpm test` (325 tests)
- **PRs**: CI runs lint + tests + commitlint on every PR

***

## 📄 License

[MIT](LICENSE)
