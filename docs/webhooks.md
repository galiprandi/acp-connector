# Event webhooks

[← Back to README](../README.md)

`webhooks` replays bridge and agent events as JSON `POST`s to your own HTTP
endpoints — n8n, Home Assistant, custom dashboards, audit sinks. It is
**outbound only**: it never affects prompt processing, and delivery is
fire-and-forget (failures are logged, never retried and never block the
queue).

## Configuration

```jsonc
{
  "webhooks": [
    {
      "url": "https://example.com/acp-events",
      "events": ["prompt.completed", "prompt.error", "agent.exited"],
      "secret": "shared-secret",                 // optional — enables x-acp-signature
      "headers": { "Authorization": "Bearer x" } // optional — merged into every POST
    }
  ]
}
```

- `events` is an **allowlist**:
  - `"*"` — every event
  - `"prefix.*"` — a whole namespace (`"prompt.*"`, `"job.*"`, `"permission.*"`)
  - `"prompt.completed"` — exactly that event
- Multiple endpoints are independent — each has its own allowlist, secret
  and headers.
- User-supplied `headers` are merged but cannot override the transport
  headers (`x-acp-event`, `x-acp-delivery`, `x-acp-signature`).

## Payload shape

Every delivery is one JSON object:

```json
{
  "id": "a1b2c3-…",                // unique per delivery attempt (x-acp-delivery)
  "event": "prompt.completed",
  "at": "2026-11-18T15:30:00.000Z",
  "bridge": { "name": "acp-connector", "version": "0.19.0" },
  "sessionId": "nimble-mozzarella",
  "platform": "telegram",
  "chatId": 951169665,
  "source": "http",                // only for prompt.* events from injected sources
  "data": { /* event-specific fields */ }
}
```

Headers sent on every POST: `content-type: application/json`,
`user-agent: acp-connector/<version>`, `x-acp-event`, `x-acp-delivery`, and
`x-acp-signature` when a `secret` is set.

## Signature verification

With `secret` set, the raw request body is signed with HMAC-SHA256:

```
x-acp-signature: sha256=<hex-hmac>
```

Verify by recomputing `HMAC_SHA256(secret, rawBody)` and comparing against
the header (constant-time compare). Same scheme as GitHub webhooks.

## Event catalog

| Event | `data` fields | Fired when |
|---|---|---|
| `bridge.started` | `agentCmd`, `sessionId`, `sessionRestored`, `platforms[]` | Bridge is up and the agent session exists |
| `bridge.stopping` | `signal` | SIGINT/SIGTERM shutdown begins |
| `agent.exited` | `code` | The agent process died unexpectedly |
| `session.changed` | `sessionId` | Active session created/switched/restored |
| `prompt.received` | `text`, `sender?` | A message lands in the prompt queue (all sources) |
| `prompt.started` | `text` | A queued prompt starts processing |
| `prompt.completed` | `text`, `response`, `stopReason`, `durationMs` | Turn finished — `response` is the final text |
| `prompt.error` | `text`, `error`, `durationMs` | Prompt processing threw |
| `prompt.cancelled` | — | `/stop` cancelled the active turn |
| `permission.request` | `toolCall`, `options[]` (`optionId`/`name`/`kind`) | Agent asked for a permission decision |
| `permission.decision` | `toolCall`, `outcome` (`outcome`, `optionId?`) | The request resolved (selected/cancelled) |
| `job.fired` | `id`, `name`, `managed`, `trigger`, `prompt`, `chatId` | A job delivered its prompt (once/cron/manual-run) |
| `job.failed` | `id`, `name`, `managed`, `trigger`, `error` | A job could not be delivered (e.g. no chat target) |

Notes:

- `source` (`job`, `agent-job`, `http`, `a2a`) appears on `prompt.*` events
  for injected prompts; user chat messages have no `source`.
- Streaming chunks (`agent_message_chunk`, tool calls, plan updates) are
  **not** replayed in this version — the completed response arrives once in
  `prompt.completed`.
- Chat commands (`/sessions`, `/jobs`, …) handled by the bridge never reach
  the prompt pipeline and emit no `prompt.*` events.

## Security notes

- **SSRF**: there is no host allowlist for webhook URLs — the operator owns
  the config file, so this is trusted input (unlike per-request
  `callbackUrl` on POST /prompt, which is attacker-influenced and guarded).
- Always set `secret` on internet-facing endpoints so receivers can verify
  payloads came from your bridge.
- Payloads may contain prompt and response text — treat the endpoint as
  sensitive and prefer HTTPS.
