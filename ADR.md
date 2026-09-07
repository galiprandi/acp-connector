# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| ADR-001 | Migration from JavaScript to TypeScript | Accepted |
| ADR-002 | Multi-platform support (Telegram + Discord) | Accepted |
| ADR-003 | Serialized queue for prompts | Accepted |

## ADR-001: Migration from JavaScript to TypeScript

**Context**: The project started in pure JavaScript and migrated to TypeScript in commit a5a4d4a.
**Decision**: Migrate to TypeScript with strict mode, ESM, target ES2022.
**Consequences**: Better type safety, better DX, requires tsc/tsx.

## ADR-002: Multi-platform support

**Context**: Originally Telegram only. Discord added in v0.2.0.
**Decision**: Shared PlatformBot interface, BridgeBot and DiscordBot implement it.
**Consequences**: Duplicated code (~80%), but platform independence.

## ADR-003: Serialized queue

**Context**: ACP session/prompt is blocking.
**Decision**: One prompt at a time per session, FIFO queue.
**Consequences**: No concurrency, latency for queued prompts.
