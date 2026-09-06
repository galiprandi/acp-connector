# Changelog

All notable changes to acp-connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-06

### Added
- Media handling — photos, documents, stickers, videos, files from Telegram and Discord
  - Images: if agent supports `image` capability → base64 `ImageContent`
  - Other files: `ResourceLink` with `file://` URI (all agents MUST support)
  - Files saved to configurable `media.uploadsDir` (default `/tmp/acp-connector-uploads`)
  - Log: `📄 file saved: /path/to/file.ext`
  - Captions included as text blocks
- HTTP `/prompt` now accepts `files` array with base64-encoded content
  - Images → `ImageContent` blocks
  - Other files → `ResourceLink` with data URI
  - Multiple files supported, backward compatible
- `AcpClient.prompt()` accepts `string | ContentBlock | ContentBlock[]`
- `AcpClient.promptCapabilities` stored from agent init response
- MCP server transports documented (stdio, HTTP, SSE, ACP)

## [0.2.0] - 2026-09-06

### Added
- Discord platform support (`discord.js`)
- Shared `PlatformBot` abstraction for Telegram and Discord
- Setup wizard supports Discord configuration
- Discord Snowflake IDs stored as strings throughout

## [0.1.0] - 2026-09-06

### Added
- ACP client (`src/acp-client.js`) — spawns any ACP agent, handles session lifecycle
- Telegram bot (`src/bot.js`) — allowlist, serialized queue, stream batching, markdown fallback, permission buttons
- Cron scheduler (`src/cron.js`) — scheduled prompts with add/remove/toggle/run
- Routine manager (`src/routines.js`) — named prompts with `/cron`, `/routine`, `/run` commands
- HTTP server (`src/http.js`) — optional `/health` and `/prompt` endpoints
  - Query params as context: `POST /prompt?origin=outlook&from=boss` → `[origin=outlook, from=boss] <body>`
  - Raw body support: if no `text` field, entire body is used as prompt
  - Bearer token auth (optional)
  - Body size limit (default 1MB, 413 on exceed)
  - Rate limiting (default 60 req/min, 429 on exceed)
  - `forwardHeaders` option (Authorization always stripped)
  - Defaults to `127.0.0.1` (localhost only)
- Bridge wiring (`src/bridge.js`) — orchestrates all components with graceful shutdown
- Setup wizard with step-by-step guidance, agent examples, and next steps
- `/start` and `/help` built-in commands with full command reference
- Bridge commands (`/run`, `/cron`, `/routine`) work from Telegram, cron, and HTTP
- Config validation with clear field-specific errors
- 189 tests across 13 test files (108 edge-case tests included)
- Professional README with architecture diagram, full config reference, and troubleshooting
- Biome lint + format, commitlint, husky pre-commit hooks

### Changed
- All modules are agent-agnostic (no hardcoded agent references)
- Config is the single source of truth (`acp-connector.jsonc`)
- Config loader/saver accepts optional path parameter (testable)
- Cron parser takes 5-token schedule (was 1-token, broke multi-field cron)
- HTTP `/prompt` accepts raw body when no `text` field (backward compatible)

### Fixed
- ACP client: spawn failure (ENOENT) never rejected `start()`
- ACP client: double `start()`/`kill()` not idempotent
- Bot: empty text forwarded to agent instead of ignored
- Bot: permission with no options hung forever
- Cron: empty prompt not validated
- Config: empty/comment-only files crashed with `SyntaxError`
- Config: no validation of required fields (`agentCmd`, `telegramToken`, `allowedChatIds`)
- Config: `saveConfig(null)` wrote `"null"` to file
- HTTP: whitespace-only text accepted as valid prompt
- HTTP: non-string text accepted as valid prompt
- HTTP: empty body returned cryptic JSON parse error
- Bridge: invalid config crashed with stack trace instead of clean error

## [0.0.4] - 2026-09-06

### Fixed
- Use Node 22 in CI (npm 12 requires Node 22+)

## [0.0.3] - 2026-09-06

### Fixed
- Remove registry-url from setup-node (interferes with OIDC)
- Upgrade npm to latest in CI for trusted publishing support

## [0.0.2] - 2026-09-06

### Fixed
- Trusted publishing now allows direct publish

## [0.0.1] - 2026-09-06

### Changed
- Switched CI/CD from NPM_TOKEN secret to npm Trusted Publishing (OIDC)
- Renamed package from acpbridge to acp-connector (npm name collision)

## [0.0.0] - 2026-09-06

### Added
- Project scaffold: package.json, bin entry, ES modules
- Config loader for `acp-connector.jsonc` (JSONC parser with comment/trailing comma stripping)
- Interactive setup wizard (`acp-connector setup`) — prompts for Telegram token, agent command, chat ID
- Bridge entrypoint with startup banner and placeholder modules
- Example config (`.config.example.jsonc`) with documented options
- AGENTS.md and README.md

### Notes
- This is an initial scaffold. No functionality is wired yet — ACP client, Telegram bot, cron, and HTTP are placeholders.
- Designed to be agent-agnostic: any ACP-compatible agent can be configured via `agentCmd`.
