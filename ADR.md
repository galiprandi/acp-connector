# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| ADR-001 | Migration from JavaScript to TypeScript | Accepted |
| ADR-002 | Multi-platform support (Telegram + Discord) | Accepted |
| ADR-003 | Serialized queue for prompts | Accepted |
| ADR-004 | A2A agent network (peer discovery, trust, delegation) | Proposed |

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

## ADR-004: A2A agent network

**Context**: Users run multiple acp-connector instances (one per agent repo). We want them to discover each other and delegate tasks — a network of single-responsibility agents (personal assistant, job-seeker, etc.). Constraint: everything on the wire must be pure A2A protocol; we only fill the gaps the spec deliberately leaves open (peer discovery, trust establishment). Must be deployment-agnostic: same host, LAN, container networks, or internet — this is a public library, not a single-user tool.

**Decision**:

1. **Mesh, not broker.** Agents talk A2A directly (client→server per spec). No traffic is routed through any intermediary. The registry is discovery-only — a curated registry per the spec's own discovery strategy #2 — and may be a standalone service (`--registry-only`, no agent behind) or an agent that also serves the role.

2. **A2A surface inside the bridge.** acp-connector serves `/.well-known/agent-card.json` and the JSON-RPC binding (`message/send`, `tasks/*`, streaming). Inbound A2A messages become `enqueuePrompt()` calls with a sender/taskId prefix; the agent's reply returns as the task result/artifact. Agent permissions still route to the owner — human approval stays in the loop by design.

3. **Discovery is pluggable, always resolving to a card URL:**
   - `a2a.registry` / `a2a.peers` in config (explicit; containers, remote peers)
   - `~/.acp-connector/instances.json` shared file (same-host auto-registration at boot)
   - mDNS `_a2a._tcp.local` broadcast (LAN autodiscovery)
   After discovery, the card is always fetched via the well-known URI — discovery only yields URLs.

4. **Config vs network state.** `acp-connector.jsonc` holds human intent only: `a2a.enabled`, card fields (name, description, skills, policies), `a2a.registry`, `a2a.trustedPeers`. Runtime state (discovered/approved peers, pending requests, lastSeen) lives in `.acp-connector/network.json` (gitignored). The bridge merges declared + discovered peers at boot.

5. **Trust = double opt-in, out-of-band.** Every join requires explicit approval from *both* owners via their configured PlatformBot channels. Same owner does NOT imply auto-approval. Pairing is our UX for the spec's recommended out-of-band credential exchange: on approval both sides record the peer; credentials are phase-appropriate (approved-membership list on trusted LAN, per `securitySchemes` — mTLS/OAuth2 — plus JWS-signed cards per spec §8.4 when exposed beyond the LAN). No insecure tunnels: remote exposure requires TLS+auth or is unsupported.
   - Pending requests persist and remind on a decaying schedule (immediate → +24h → +72h → at startup) until resolved.
   - States: `pending | approved | rejected | ignored | revoked`. `ignored` = silent (no rejection notice), reversible.
   - Revocation propagates to known peers (A2A push notifications); while the registry is down, already-known peers keep working — only new joins/revocations stall.

6. **Multi-channel notifications.** Network notifications and approval requests are sent through *all* configured PlatformBots (Telegram, Discord, future Slack = new PlatformBot impl). First response wins; pending prompts are invalidated on the other channels (same routing pattern as permission requests). `/a2a` commands are answered by the bridge on the PlatformBot interface — never reach the agent.
   - `/a2a` status · `/a2a pending` · `/a2a peers` · `/a2a approve|reject|ignore|revoke <id>` · `/a2a card` (audit own exposure) · `/a2a ping <peer>`.

7. **Safety rails:** `taskId` dedup (retries must not re-execute real-world side effects); `delegationChain` in message `metadata` + depth limit to prevent A→B→A delegation loops; first-wins registry collision rule (second candidate warns and boots as a plain peer); liveness via `lastSeen` heartbeats and deregistration on cooperative shutdown; append-only `.acp-connector/audit.log` of delegations; `schemaVersion` on persisted state for migrations.

**Consequences**: Spec-compliant interop (any A2A client can talk to a bridged agent), privacy between owners (registry never sees task content), graceful degradation (known peers keep working without registry), at the cost of implementing the registry API and pairing UX ourselves — both deliberately unstandardized by the spec.
