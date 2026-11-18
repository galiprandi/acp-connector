# Protocol support matrix

← Back to [README](../README.md)

## Supported agents

Any agent that implements the [Agent Client Protocol](https://agentclientprotocol.com/) works. Configure it via `agentCmd`:

| Agent | Example `agentCmd` |
|---|---|
| [Devin](https://devin.ai) | `devin acp` |
| [Claude Code](https://claude.ai/code) | `claude acp` |
| [Codex](https://openai.com/codex) | `codex acp` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini acp` |
| [OpenCode](https://github.com/sst/opencode) | `opencode acp` |
| [pi](https://github.com/badlogic/pi) | `npx pi-acp` (via [pi-acp](https://github.com/svkozak/pi-acp) adapter) |
| [Antigravity](https://antigravity.google) | `npx agy-acp` (via `agy-acp` adapter) |
| Any ACP agent | `<your-agent> acp` |

Verified end-to-end with A2A delegation: `devin acp` orchestrating `opencode acp`,
`pi-acp` and `agy-acp` peers.

## A2A (agent ↔ agent)

| Feature | Status | Notes |
|---|---|---|
| `message/send` | ✅ | Inbound tasks become queued agent prompts |
| `message/stream` (SSE) | ✅ | Task(working) → status-update events → completed |
| `contextId` | ✅ | Echoed back; used for correlation, not session state |
| `taskId` dedup | ✅ | Duplicate deliveries rejected with `-32002` |
| Delegation-chain / loop prevention | ✅ | Via `a2a.delegationChain` metadata (extension) |
| `/.well-known/agent-card.json` | ✅ | Generated from `a2a.card` config |
| `tasks/get`, `tasks/cancel` | ❌ | No long-running task tracking yet |
| Push notifications (`tasks/pushNotificationConfig`) | ❌ | Long tasks block until done |
| Agent Card signatures (JWS) | ❌ | Phase 2 (remote/internet trust) |
| `securitySchemes` enforcement | ⚠️ | Declared in card, but inbound auth is LAN trust (`X-A2A-Peer-Id`) — TLS + real auth is phase 2 |
| Extended Agent Card | ❌ | |
| Discovery: well-known URI | ✅ | Standard fetch after URL resolution |
| Discovery: curated registry | ✅ | `a2a.registryMode` + `a2a.registry` |
| Discovery: direct config | ✅ | `a2a.trustedPeers` |
| mDNS broadcast discovery | ✅ | Optional dep `bonjour-service` |
| Shared-file discovery | ✅ | `~/.acp-connector/instances.json` |

## ACP (bridge ↔ agent)

| Feature | Status | Notes |
|---|---|---|
| `initialize` / capability negotiation | ✅ | |
| `session/new` + `session/load` / `resume` / `list` / `close` / `delete` | ✅ | Session persistence per chat |
| `session/prompt` with streaming updates | ✅ | `agent_message_chunk` batched to the chat |
| `session/request_permission` | ✅ | Routed to Telegram buttons / Discord / auto-approved headless |
| `session/set_mode`, `set_config_option` | ✅ | Per-agent capability detection |
| `mcpServers` in `session/new` | ✅ | Used to inject the `a2a-network` MCP tools |
| `available_commands` | ✅ | Tracked in client state (not shown in `/help`) |
| `fs/*`, `terminal/*` client capabilities | ❌ | Not implemented — agents get no fs/terminal via the bridge |
| `authenticate` | ❌ | Agents are expected pre-authenticated |
| Image / embedded context | ✅ | `image` + `ResourceLink` media support |
| Audio | ⚠️ | Voice notes are transcribed to text by default (sherpa-onnx, on-device); audio/video files are sent as `ResourceLink` — no ACP audio content block |
