# Architecture Decision Records

| ADR | Título | Estado |
|-----|--------|--------|
| ADR-001 | Migración de JavaScript a TypeScript | Accepted |
| ADR-002 | Soporte multi-plataforma (Telegram + Discord) | Accepted |
| ADR-003 | Cola serializada para prompts | Accepted |

## ADR-001: Migración de JavaScript a TypeScript

**Contexto**: El proyecto comenzó en JavaScript puro y migró a TypeScript en el commit a5a4d4a.
**Decisión**: Migrar a TypeScript con strict mode, ESM, target ES2022.
**Consecuencias**: Mejor type safety, mejor DX, requiere tsc/tsx.

## ADR-002: Soporte multi-plataforma

**Contexto**: Originalmente solo Telegram. Discord agregado en v0.2.0.
**Decisión**: Interfaz PlatformBot compartida, BridgeBot y DiscordBot la implementan.
**Consecuencias**: Código duplicado (~80%), pero independencia de plataforma.

## ADR-003: Cola serializada

**Contexto**: ACP session/prompt es bloqueante.
**Decisión**: Una sola prompt a la vez por sesión, cola FIFO.
**Consecuencias**: Sin concurrencia, latencia para prompts encolados.
