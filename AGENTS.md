# AGENTS.md — acp-connector

Thin bridge connecting messaging platforms to any ACP-compatible coding agent via ACP.

## Stack

- TypeScript (ES modules)
- pnpm
- @agentclientprotocol/sdk, node-telegram-bot-api, discord.js, node-cron
- Biome (lint + format)
- Vitest (tests + coverage)
- commitlint + husky (conventional commits enforcement)

## Commands

- `pnpm start` — run the bridge (via tsx)
- `pnpm build` — compile TS to dist/
- `pnpm setup` — interactive setup wizard
- `pnpm test` — run tests
- `pnpm test:coverage` — run tests with coverage
- `pnpm typecheck` — type-check without emitting
- `pnpm lint` — check lint + format
- `pnpm lint:fix` — auto-fix lint + format issues

## Commit conventions

All commits MUST follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`

Enforced by:
- **commitlint** — commit-msg hook blocks non-conventional commits
- **husky pre-commit** — runs Biome lint + Vitest tests before commit
- **CI** — runs lint + tests + commitlint on every PR

## Release process

Releases are manual. There is no auto-release CI.

To release a new version:

1. Ensure `main` is clean and tests pass: `pnpm test && pnpm lint`
2. Bump version in `package.json` (follow semver):
   - `patch` (0.0.x): bug fixes, docs
   - `minor` (0.x.0): new features, backward-compatible
   - `major` (x.0.0): breaking changes
3. Update `CHANGELOG.md` with the new version and changes
4. Commit: `chore(release): vX.Y.Z`
5. Tag: `git tag vX.Y.Z`
6. Push: `git push && git push --tags`
7. Create GitHub release from the tag (triggers publish workflow with OIDC trusted publishing)
8. Verify the package appears on npm: `npm view acp-connector version`

## CI/CD

- **CI workflow** (`.github/workflows/ci.yml`): lint + tests on push to main and PRs
- **Publish workflow** (`.github/workflows/publish.yml`): npm publish via OIDC trusted publishing on GitHub release

## Config

Single `acp-connector.jsonc` file in cwd. See `acp-connector.example.jsonc` for all options.

## Architecture

```
src/
├── index.ts       — CLI entrypoint (setup or run)
├── bridge.ts      — orchestrates all components
├── acp-client.ts  — spawns ACP agent, handles protocol + sessions
├── bot.ts         — Telegram bot, message queue, stream batching, PlatformBot interface
├── discord.ts     — Discord bot, implements PlatformBot
├── media.ts       — MediaHandler: download, save, convert to ACP ContentBlocks
├── cron.ts        — scheduled prompt injection
├── routines.ts    — named prompts + /cron, /routine, /run commands
├── http.ts        — optional HTTP API (/health, /prompt)
├── config.ts      — JSONC config loader/saver, platforms support
└── setup.ts       — interactive setup wizard (Telegram + Discord)
```

### Data flow

1. Input sources (Telegram, Discord, cron, HTTP) enqueue prompts via `bot.enqueuePrompt()`
2. Queue is processed one at a time (ACP `session/prompt` is blocking)
3. Agent responses stream back via `session.nextUpdate()`
4. `bot._handleUpdate()` batches chunks and edits a single Telegram message
5. Permissions are forwarded as inline buttons (or auto-approved)

### Key principles

- **Thin bridge**: no agent loop, no model provider, no tool ecosystem
- **Agent-agnostic**: no hardcoded agent references anywhere
- **Config is truth**: all state in `acp-connector.jsonc`, persisted by routines
- **Serialized queue**: one prompt at a time, no concurrent prompts
