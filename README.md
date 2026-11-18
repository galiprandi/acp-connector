# acp-connector

> 🔌 Thin bridge between messaging platforms and any ACP agent — and an A2A node: agents that discover each other and delegate work.

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

**acp-connector** does two jobs:

1. **Platform bridge**: connects [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) coding agents to Telegram and Discord — forwards your messages to the agent and streams responses back.
2. **A2A node**: when `a2a.enabled`, the bridge joins an [A2A](https://a2a-protocol.org/) agent network — your agent gets discovered by other agents, and can discover and delegate to them.

The bridge is intentionally thin. It doesn't implement its own agent loop, model provider, or tool ecosystem. It launches your agent, passes prompts through, relays responses back, and exposes a standard A2A surface. That's it.

**Key features:**
- 🤝 **A2A agent network** — peer discovery (LAN broadcast, shared file, registry), double opt-in pairing, `message/send` + `message/stream` (SSE), `list_remote_agents`/`send_message` MCP tools so agents can delegate on their own
- 🛠 **`acp-tools` MCP for your agent** — `send_file`/`list_aliases` for delivering files to chats, plus a `jobs` tool for self-scheduled work
- ⏰ **Unified jobs** — one-shot reminders, recurring schedules and named manual jobs in a single `/jobs` surface. Persisted, late-delivery safe, human time strings
- 🤖 Works with any ACP agent (Devin, Claude Code, Codex, OpenCode, pi, Antigravity)
- 💬 Telegram and Discord with streaming responses; headless mode for containers/test rigs
- 🌐 Optional HTTP API — `/prompt` with webhook callbacks, bearer auth
- 🔐 Bearer token auth, rate limiting, body size limits
- 🧠 Agent thoughts forwarding (optional)
- 📋 Permission requests as inline buttons

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

Check the installed version with `acp-connector --version` (or `-v`).

For other install paths — the `assistant-setup` single-file wizard, the all-in-one container image, systemd/pm2 units and headless mode — see [docs/deployment.md](docs/deployment.md).

## ⚡ Quick start

```bash
# 1. Create a Telegram bot via @BotFather, get the token
# 2. Run the setup wizard
npx acp-connector setup

# 3. Start the bridge
npx acp-connector
```

Send a message to your bot on Telegram. Your agent will respond. That's it.

A minimal `acp-connector.jsonc` looks like:

```jsonc
{
  "agentCmd": "devin acp",
  "platforms": {
    "telegram": { "token": "123:abc", "allowedChatIds": [123456789] }
  }
}
```

See [docs/configuration.md](docs/configuration.md) for the full option reference and [`acp-connector.example.jsonc`](acp-connector.example.jsonc) for every field.

## 💬 Commands

The bridge intercepts these commands before forwarding to the agent; both Telegram and Discord support them. Full syntax in [docs/commands.md](docs/commands.md).

| Command | Description |
|---|---|
| `/stop` | Cancel the current task and clear the pending queue |
| `/queue` | List pending prompts (`/queue rm <n>`, `/queue clear`) |
| `/status` | Bridge/agent/session/queue/jobs status summary |
| `/time` | Show host zone, configured `timezone`, and UTC |
| `/sessions` | List/switch/delete agent sessions (`new`, `<n\|id>`, `rm`) |
| `/config` | List/set agent config options (model, mode, thought level) |
| `/jobs` | List/add/run/toggle/remove scheduled and manual jobs |
| `/a2a` | A2A network status, pairing and peer management |
| `/start`, `/help` | Welcome message with command list |

Any other message (including unknown `/commands` and commands the agent advertises) is forwarded directly to the agent.

## 📚 Documentation

- [Configuration reference](docs/configuration.md) — every `acp-connector.jsonc` field, HTTP API, media, voice transcription, MCP servers, jobs model, security knobs and deprecated fields.
- [Chat commands](docs/commands.md) — full `/sessions`, `/config`, `/queue`, `/jobs`, `/time`, `/status`, `/stop`, `/help` syntax, `<when>` forms and timezone rules.
- [Architecture](docs/architecture.md) — data flow, serialized queue, streaming edits, permissions, session persistence, `state.json` migration.
- [acp-tools MCP](docs/acp-tools.md) — `send_file`, `list_aliases`, `jobs` agent tools, sender-identity prefixes and chat aliases.
- [A2A agent network](docs/a2a.md) — peer discovery, double opt-in pairing, HMAC peer auth, registry role, headless mode.
- [Protocol support matrix](docs/protocol.md) — supported agents and the ACP/A2A feature matrices.
- [Deployment](docs/deployment.md) — `assistant-setup` wizard, container image, systemd/pm2, headless mode.
- [Testing](docs/testing.md) — unit + fake-agent e2e, `BEHAVIOR.md`, the real-agent matrix (`ACP_MATRIX=1`).
- [Event webhooks](docs/webhooks.md) — outbound `webhooks[]` config, event catalog, payload shape and HMAC signature.
- [Troubleshooting](docs/troubleshooting.md) — common errors, MCP loading, Telegram rate limits.

## 🤝 Contributing

See [AGENTS.md](AGENTS.md) for development setup, commit conventions, and release process.

- **Development**: `pnpm start` (run), `pnpm build`, `pnpm typecheck`, `pnpm lint` / `pnpm lint:fix`
- **Tests**: `pnpm test` (unit + fake-agent e2e), `ACP_MATRIX=1 pnpm test:matrix` (real-agent matrix) — details in [docs/testing.md](docs/testing.md)
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint
- **Linting**: [Biome](https://biomejs.dev/)
- **PRs**: CI runs lint + tests + commitlint on every PR

## 📄 License

[MIT](LICENSE)
