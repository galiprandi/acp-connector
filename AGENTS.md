# AGENTS.md — acp-connector

Thin bridge connecting messaging platforms to any ACP-compatible coding agent via ACP.

## Stack

- Node.js ES modules
- pnpm
- @agentclientprotocol/sdk, node-telegram-bot-api, node-cron
- Biome (lint + format)
- Vitest (tests + coverage)
- commitlint + husky (conventional commits enforcement)

## Commands

- `pnpm start` — run the bridge
- `node src/index.js setup` — interactive setup wizard
- `pnpm test` — run tests
- `pnpm test:coverage` — run tests with coverage
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

Single `.config.jsonc` file in cwd. See `.config.example.jsonc` for all options.
