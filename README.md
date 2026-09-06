# acp-connector

> Control any ACP-compatible coding agent from Telegram, cron, or HTTP.

[![npm version](https://img.shields.io/npm/v/acp-connector.svg)](https://www.npmjs.com/package/acp-connector)
[![license](https://img.shields.io/npm/l/acp-connector.svg)](https://github.com/galiprandi/acp-connector/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/acp-connector.svg)](https://nodejs.org)

---

## What is this?

`acp-connector` is a thin bridge that connects messaging platforms to any [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) compatible coding agent. It's agent-agnostic: you configure the command to launch your agent, and the bridge handles the rest.

**Telegram** is the first-class interface. You send messages, the bridge forwards them to your ACP agent, and the agent's responses stream back to your chat in real time. The bridge also supports **scheduled prompts** (cron jobs) and an optional **HTTP API** for programmatic access.

The bridge is intentionally thin. It doesn't implement its own agent loop, model provider, or tool ecosystem. It launches your agent, passes prompts through, and relays responses back. That's it.

### Why?

Because your coding agent already knows how to code. You just need a way to talk to it from anywhere. Telegram is on every phone, every watch, every desktop. Your agent is on your machine. `acp-connector` connects them.

---

## Quick start

```bash
# 1. Create a Telegram bot via @BotFather, get the token
# 2. Run setup
npx acp-connector setup

# 3. Start the bridge
npx acp-connector
```

That's it. Send a message to your bot on Telegram and your agent will respond.

---

## How it works

```
┌──────────┐     ┌──────────────┐     ┌─────────────┐
│ Telegram │────▶│              │     │             │
│          │     │  acp-connector│────▶│  ACP Agent  │
│  (you)   │◀────│   (bridge)   │     │ (any agent) │
│          │     │              │◀────│             │
└──────────┘     └──────────────┘     └─────────────┘
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

---

## Configuration

All configuration lives in a single `.config.jsonc` file in your working directory. The setup wizard creates it for you, or you can write it manually.

See [`.config.example.jsonc`](.config.example.jsonc) for the full reference.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `agentCmd` | `string` | yes | — | Command to launch the ACP agent (e.g. `"devin acp"`) |
| `agentCwd` | `string` | no | `cwd` | Working directory for the agent subprocess |
| `telegramToken` | `string` | yes | — | Telegram bot token from @BotFather |
| `allowedChatIds` | `number[]` | yes | `[]` | Allowed Telegram chat IDs. Empty = setup mode |
| `sessionId` | `string` | no | — | ACP session ID to load/resume (omit to create new) |
| `sessionConfigPath` | `string` | no | — | Path to MCP/session config JSONC |
| `showThoughts` | `boolean` | no | `false` | Forward agent thoughts to Telegram |
| `streaming` | `boolean` | no | `true` | Stream responses with live message edits |
| `logLevel` | `string` | no | `"info"` | `"error"` \| `"info"` \| `"debug"` |
| `cron` | `CronJob[]` | no | `[]` | Scheduled jobs (see below) |
| `routines` | `Routine[]` | no | `[]` | Named reusable prompts |
| `http` | `HttpConfig` | no | off | HTTP server config (see below) |

### CronJob

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique job name |
| `schedule` | `string` | yes | Cron expression (e.g. `"0 9 * * *"`) |
| `prompt` | `string` | yes | Prompt to send to the agent |
| `chatId` | `number` | no | Chat to send the response to (default: first allowed) |
| `enabled` | `boolean` | no | `true` (set `false` to pause) |

### Routine

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique routine name |
| `prompt` | `string` | Prompt text |

### HttpConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Start the HTTP server |
| `port` | `number` | `7780` | Port to listen on |

---

## Supported agents

Any agent that implements the [Agent Client Protocol](https://agentclientprotocol.com/) works. Configure it via `agentCmd`:

| Agent | Example `agentCmd` |
|---|---|
| [Devin](https://devin.ai) | `devin acp` |
| [Claude Code](https://claude.ai/code) | `claude acp` |
| [Codex](https://openai.com/codex) | `codex acp` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini acp` |
| [OpenCode](https://github.com/sst/opencode) | `opencode acp` |
| Any ACP agent | `<your-agent> acp` |

---

## Telegram commands

The bridge intercepts these commands before forwarding to the agent:

### Cron management

| Command | Description |
|---|---|
| `/cron` | Show cron help |
| `/cron list` | List all cron jobs |
| `/cron add <schedule> <prompt>` | Add a new cron job |
| `/cron remove <name>` | Remove a cron job |
| `/cron toggle <name>` | Pause/activate a job |
| `/cron run <name>` | Run a job immediately |

### Routine management

| Command | Description |
|---|---|
| `/routine` | Show routine help |
| `/routine list` | List all routines |
| `/routine add <name> <prompt>` | Add a reusable prompt |
| `/routine remove <name>` | Remove a routine |

### Execution

| Command | Description |
|---|---|
| `/run <name>` | Execute a routine by name |

Any other message (including unknown `/commands`) is forwarded directly to the agent.

---

## Cron jobs

Schedule prompts to run automatically. Configure in `.config.jsonc` or manage via Telegram commands.

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

All changes persist to `.config.jsonc` automatically.

---

## Routines

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

---

## HTTP API

Optional. Enable in config:

```jsonc
{
  "http": {
    "enabled": true,
    "port": 7780
  }
}
```

### Endpoints

#### `GET /health`

```bash
curl http://localhost:7780/health
```

```json
{ "status": "ok", "agent": true, "session": "abc-123" }
```

#### `POST /prompt`

```bash
curl -X POST http://localhost:7780/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "fix the failing tests", "chatId": 123456789}'
```

```json
{ "ok": true }
```

The prompt enters the same queue as Telegram messages. If `chatId` is omitted, the first allowed chat ID is used.

---

## Permissions

ACP agents may request permission before executing certain actions (file writes, shell commands, etc.). The bridge handles this in two ways:

1. **Auto-approve**: If your `agentCmd` includes `dangerous`, `bypass`, or `yolo`, all permissions are auto-approved silently.
2. **Inline buttons**: Otherwise, the permission request is forwarded to Telegram with "Permitir" / "Denegar" buttons. Tap to approve or deny.

---

## Session persistence

To resume a session across restarts, set `sessionId` in your config:

```jsonc
{
  "sessionId": "your-session-id"
}
```

The bridge will call `session/load` or `session/resume` (depending on agent capabilities) on startup. Omit this field to create a new session each time.

---

## Self-hosting

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

---

## Troubleshooting

### `Conflict: terminated by other getUpdates request`

Another bot instance is running with the same token. Kill it:

```bash
pkill -f acp-connector
```

### Agent doesn't respond

1. Check that `agentCmd` launches your agent correctly: run it manually
2. Check the bridge console for errors
3. Ensure your chat ID is in `allowedChatIds`

### MCP servers not loading

If you configured `sessionConfigPath`, verify the file exists and is valid JSONC. The bridge logs errors reading it but doesn't crash.

### Telegram rate limits

The bridge batches stream edits (800ms) to avoid rate limits. If you still hit limits, disable streaming (`"streaming": false`) to send one message per response instead.

---

## Contributing

See [AGENTS.md](AGENTS.md) for development setup, commit conventions, and release process.

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint
- **Linting**: [Biome](https://biomejs.dev/)
- **Tests**: [Vitest](https://vitest.dev/) — `pnpm test`
- **PRs**: CI runs lint + tests + commitlint on every PR

---

## License

[MIT](LICENSE)
