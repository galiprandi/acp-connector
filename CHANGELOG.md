# Changelog

All notable changes to acp-connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-06

### Added
- ACP client (`src/acp-client.js`) — spawns any ACP agent, handles session lifecycle
- Telegram bot (`src/bot.js`) — allowlist, serialized queue, stream batching, markdown fallback, permission buttons
- Cron scheduler (`src/cron.js`) — scheduled prompts with add/remove/toggle/run
- Routine manager (`src/routines.js`) — named prompts with `/cron`, `/routine`, `/run` commands
- HTTP server (`src/http.js`) — optional `/health` and `/prompt` endpoints
- Bridge wiring (`src/bridge.js`) — orchestrates all components with graceful shutdown
- Setup wizard updated with sessionConfigPath and showThoughts prompts
- 81 tests across 7 test files (78.69% statement coverage)
- Professional README with architecture diagram, full config reference, and troubleshooting
- Biome lint + format, commitlint, husky pre-commit hooks

### Changed
- All modules are agent-agnostic (no hardcoded agent references)
- Config is the single source of truth (`.config.jsonc`)

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
- Config loader for `.config.jsonc` (JSONC parser with comment/trailing comma stripping)
- Interactive setup wizard (`acp-connector setup`) — prompts for Telegram token, agent command, chat ID
- Bridge entrypoint with startup banner and placeholder modules
- Example config (`.config.example.jsonc`) with documented options
- AGENTS.md and README.md

### Notes
- This is an initial scaffold. No functionality is wired yet — ACP client, Telegram bot, cron, and HTTP are placeholders.
- Designed to be agent-agnostic: any ACP-compatible agent can be configured via `agentCmd`.
