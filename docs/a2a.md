# A2A agent network (experimental)

← Back to [README](../README.md)

Enable `a2a.enabled` to put this bridge on an [A2A](https://a2a-protocol.org/) agent
network — your agent becomes a first-class peer that can discover other agents and
delegate tasks to them (and vice versa). Everything on the wire is standard A2A;
peer discovery and owner approval are local glue the spec deliberately leaves open.

## How it works

```
 your agent (any ACP agent)
   │  tools: list_remote_agents, send_message        ← MCP, injected at session start
   ▼
 acp-connector (this bridge)
   │  /.well-known/agent-card.json                    ← your public card
   │  JSON-RPC message/send                           ← inbound tasks from peers
   │  /a2a/join, /a2a/confirm                         ← pairing (deployment glue)
   ▼
 remote peers                                        ← direct mesh, no broker
```

**Two directions, one config:**

- **Inbound**: approved peers send `message/send` (single response) or
  `message/stream` (SSE: task → status-update events → completed) → tasks enter
  the agent's prompt queue prefixed with `[A2A from <peer> | task <id>]` → the
  agent's reply is streamed chunk-by-chunk and completed as the A2A result.
  `contextId` is echoed back on both paths.
- **Outbound**: the agent sees two MCP tools — `list_remote_agents()` and
  `send_message(agent_name, message)` — following the reference host-agent pattern
  from the official A2A samples. Agents without MCP support simply don't see them.

## Peer discovery

Peers are discovered by three strategies, all resolving to an Agent Card URL:

| Strategy | When | How |
|---|---|---|
| Shared instances file | Same machine | `~/.acp-connector/instances.json` — auto-registered at boot, deregistered on shutdown |
| mDNS broadcast | LAN | `_a2a._tcp.local` (requires optional `bonjour-service` dep) |
| Static config | Containers / remote | `a2a.registry` URL or `a2a.trustedPeers` |

After discovery, the card is always fetched via the standard well-known URI.

## Trust model — double opt-in

Joining the network requires **explicit approval from both owners**:

1. You discover a peer → `/a2a join <id>` → your card is sent to their `/a2a/join`
2. Their owner gets notified and runs `/a2a approve <you>` → your side gets a confirm callback
3. Your owner runs `/a2a approve <them>` → both sides end up `approved`

The confirm callback is **informational only** — it never grants trust by
itself. Each side's operator must run `/a2a approve`; there is no auto-promotion
(v0.13.0+, audit SEC-01). On approval the bridge also issues a random
per-pairing secret delivered once inside the approve → confirm POST — see
[Peer authentication](#peer-authentication).

Same owner does **not** imply auto-approval. Pending requests persist in
`.acp-connector/state.json` and are re-announced on startup until resolved
(approve / reject / ignore / revoke — `ignored` is silent, `rejected` is explicit).

**Inbound security:**

- Only `approved` peers can send tasks — anything else is rejected before any
  processing (the prompt is never built)
- Peer identity uses the `X-A2A-Peer-Id` header; when a pairing secret exists,
  requests must also carry an `X-A2A-Peer-Signature` HMAC (see *Peer
  authentication* below). For exposure beyond a trusted LAN set
  `a2a.secure: true`, declare `securitySchemes` in your card, and terminate TLS
  in front — plain insecure tunnels are not supported
- **Remote content never triggers bridge commands**: A2A-injected text that
  starts with `/` is treated as agent input, not as a command. Commands work
  on every operator entry point (Telegram, Discord, `/prompt`, `/jobs`)
- Task-id dedup prevents retries re-executing side effects; delegation-chain
  metadata + a depth limit prevent A→B→A loops
- Approved peers' cards are refreshed periodically from their well-known URI —
  new skills propagate automatically; if a registry is configured, the instance
  announces itself on the same interval
- Every membership and task event is appended to `.acp-connector/audit.log`
  (JSONL) — who delegated what, approvals, rejections, discoveries

## Peer authentication

Peer ids are public (they appear in agent cards, `/a2a/peers`, mDNS and
`state.json`), so the id header alone is not a secret. When a peer is
approved (`/a2a approve`), the bridge issues a **random per-pairing secret**,
stores it in its peer record, and delivers it once inside the approve →
confirm POST. Both sides then sign A2A traffic with the same key:

- Outbound: `message/send` delegations and registry announces carry
  `X-A2A-Peer-Signature: hex(HMAC-SHA256(secret, raw-body))` whenever a secret
  for the target peer exists
- Inbound: a present signature must verify against the raw body — mismatch is
  rejected before any processing

`a2a.secure` defaults to `true`: signatures are mandatory and unsigned peers
are rejected with a `signature required` error. Set `secure: false` only for
mixed-version meshes during migration — unsigned requests are then accepted
but audited as `legacy-peer` (once per peer). Known tradeoff: the pairing
secret itself crosses the wire exactly once (in the approve → confirm POST),
so a first-message man-in-the-middle on a plain-HTTP LAN could capture it —
accepted for LAN deployments without TLS.

## Registry role

`a2a.registryMode: true` turns the instance into a **discovery-only directory**:
`GET /a2a/registry/agents` lists approved peers' cards (optionally filtered by
`?skill=<id>`), `POST /a2a/registry/announce` lets peers refresh their card and
liveness. The registry never sees task content — delegation stays peer-to-peer.

## `/a2a` commands

| Command | Description |
|---|---|
| `/a2a` | Network status: peers grouped by state |
| `/a2a pending` | Pending join requests |
| `/a2a peers` | Approved peers |
| `/a2a join <id>` | Send a join request to a discovered peer |
| `/a2a approve\|reject\|ignore\|revoke <id>` | Manage membership |
| `/a2a card` | Show your card endpoint |

## Headless mode

The bridge can run with **no messaging platform at all**: configure only
`http.enabled` (for `/prompt` input) and/or `a2a.enabled` (for peer tasks).
A loopback queue processor drives the ACP session and permissions are
auto-approved (no human in the loop — use only on trusted environments).

```jsonc
{
  "agentCmd": "devin acp",
  "http": { "enabled": true, "port": 7760 },
  "a2a": { "enabled": true, "id": "my-agent", "card": { "name": "...", "description": "..." } }
}
```
