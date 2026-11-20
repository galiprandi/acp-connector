---
name: release-testing
description: Mandatory pre-release test checklist for acp-connector — unit suite, e2e suites, and the real-agent matrix (devin/opencode/dsh/agy). Use before every version bump, npm publish, or bridge redeploy.
---

# Pre-release testing checklist

Run ALL of these before `chore(release)` / `npm publish` / redeploying a
bridge. Zero tolerance for skipped or failing tests — a regression in this
package hits real Telegram/Discord deployments.

## 1. Unit + integration suite

```bash
pnpm test          # vitest run — must be 100% green, no skips
pnpm lint          # biome check — clean
pnpm typecheck     # tsc --noEmit — clean
```

`pnpm test` includes the fake-agent e2e suites (`test/e2e/*.e2e.test.ts`)
that spawn real bridge processes over stdio/HTTP — no external agents or
credentials needed. If one flakes on network timing, re-run once before
declaring failure.

## 2. Real-agent matrix (mandatory for protocol/command changes)

```bash
pnpm test:matrix                                # all installed agents
ACP_MATRIX_AGENTS=devin,opencode pnpm test:matrix   # subset
```

`test/e2e/agent-matrix/` boots each real ACP agent (`devin acp`,
`opencode acp`, `dsh acp`, `npx agy-acp`) in-process with a platform-free
`MatrixBot` and exercises the actual command surface: `/sessions`,
`/config` (+ synthetic `mode`), `/queue`, `/jobs` lifecycle, `/time`,
`/status`, `/help`, prompt round-trips and `session/resume`.

- Opt-in via `ACP_MATRIX=1` — never runs in plain `pnpm test`.
- Agents that can't boot report as skipped; agents without LLM
  credentials run everything except prompt round-trips — a `prompt=NO`
  boot line is expected, not a failure. `dsh acp` prompts work when the
  local `acp` profile routes via OpenRouter (`~/.dsh/profiles/acp/
  cordis.patch.yml` → `acp.provider=openrouter` + `OPENROUTER_API_KEY`);
  the stock `deepseek-official` route instead needs `DEEPSEEK_API_KEY`.
- Capability differences are asserted per-agent (configOptions,
  availableModes, resume support) — the matrix verifies the *rules*, not
  identical output.

Adding a new agent: add a row to `AGENTS` in
`test/e2e/agent-matrix/agents.ts` with its `agentCmd` and `resume`
capability (`'yes'` | `'fallback'`), then probe it once manually
(`pnpm tsx` + `AcpClient`) to confirm modes/configOptions/session support.

## 3. Targeted real-agent smoke (when the matrix doesn't cover the change)

For changes the matrix doesn't exercise (MCP tools, A2A, media,
transcription, permissions), run a focused `tsx` script against
`devin acp` **and** `opencode acp` — repo policy requires both whenever
possible (they expose capabilities differently: devin has
`availableModes`+`set_mode`, opencode prefers `configOptions`).

Mandatory flows for any session-related change: `session/new` (fresh),
`session/load`/`session/resume` (existing id), `session/prompt`, plus the
touched feature.

## Release order

1. `pnpm test && pnpm lint && pnpm typecheck` — green
2. `pnpm test:matrix` — green (or documented skips)
3. Targeted smoke for uncovered surface
4. `CHANGELOG.md` updated, conventional commit, `chore(release): vX.Y.Z` + tag + push
5. GitHub release → publish workflow → `npm view acp-connector version`
