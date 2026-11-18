# Testing

← Back to [README](../README.md)

- **Unit + fake-agent e2e**: `pnpm test` ([Vitest](https://vitest.dev/)) — always on, must stay green.
- **Coverage**: `pnpm test:coverage`.
- **Real-agent matrix**: `ACP_MATRIX=1 pnpm test:matrix` boots `devin acp`, `opencode acp`, `dsh acp` and `npx agy-acp` and runs the actual `/sessions`, `/config`, `/jobs`, `/time`, `/status`, `/help` command surface plus prompt round-trips and session resume against each — capability differences are asserted per agent. Filter with `ACP_MATRIX_AGENTS=devin,opencode`.
- **Pre-release checklist**: see `.devin/skills/release-testing/SKILL.md` for the mandatory checklist (unit + e2e + matrix + targeted `AcpClient` smoke).

## BEHAVIOR.md

`BEHAVIOR.md` is generated from test results — never edit it by hand:

```bash
pnpm behavior   # runs tests with JSON reporter, then compiles BEHAVIOR.md
```

The pre-commit hook runs `pnpm behavior` automatically, so BEHAVIOR.md stays in sync with tests.
