# `acp-tools` MCP — agent tools (messaging + scheduling)

← Back to [README](../README.md)

The bridge always injects a single `acp-tools` MCP server into `session/new`, giving the agent bridge capabilities — no config needed. Agents without MCP support simply never see the tools (a one-line warning is logged at startup).

## Sender identity in prompts

Every message you send reaches the agent prefixed with who is talking and where, so it always knows who to answer and which alias to reply to:

```
[Telegram] Germán Aliprandi: mandame el reporte        ← DM
[Telegram/Familia] Santi: pasame el resumen           ← group: bracket = chat, name = sender
[Discord/general] Germán: revisá esto                 ← Discord channel
```

The bracketed label identifies the chat — its alias is `Platform/Name` (for groups the name is the channel title; for DMs it's the sender name shown after the bracket, e.g. `Telegram/Germán Aliprandi`). The agent copies it into `send_file`'s `to` parameter, or omits `to` to reply to the current chat. Aliases are tracked automatically in `.acp-connector/state.json` (refreshed on every message, so renames self-heal) and never expose raw platform ids.

## Tools

| Tool | Purpose |
|---|---|
| `send_file({ path, caption?, to? })` | Send a local file to a chat. `to` = chat alias (e.g. `"Telegram/Familia"`); omitted = the chat that sent the current prompt. Images go as photo previews, everything else as documents. **Path allowlist**: only files inside the agent cwd, the media uploads dir, the OS tmpdir or `tools.allowedPaths` can be sent — anything else (`.env`, tokens, SSH keys…) is rejected, and files are capped at 45MB (`tools.maxFileSizeMb`) |
| `list_aliases()` | List known chat aliases (alias, platform, dm/group, name — never raw ids) for cross-chat delivery |
| `jobs({ action, ... })` | All scheduled work in one tool. `action`: `create` (`prompt` + one schedule source: `in`/`at` for once, `every`/`expr` for recurring, `manual:true`+`name` for manual), `list`, `update`/`delete`/`run`/`toggle` (`id`, `enabled`). Accepts human strings (`"15m"`, `"tomorrow 10am"`, `"1h"`) and ISO datetimes; absolute times without a zone require `timezone`. `manual:true` jobs need a `name` — the operator fires them with `/jobs run <name>` |

## Jobs are one model

A once job fires once and is deleted on delivery; recurring jobs fire on their cron expression; manual jobs only fire when triggered. If the agent isn't connected when a job fires, the entry is kept and retried — a late action beats a lost one. Jobs persist across restarts in `.acp-connector/state.json` (agent-created jobs capped at 50; once jobs past `firesAt` by more than 7 days are discarded).

Every job is tagged `managed: "agent" | "operator"`. Agent-created jobs fire as remote content (source `agent-job`): their prompt **cannot run `/` bridge commands** even if it starts with one. Operator jobs created via `/jobs` chat commands keep full operator authority. The agent API can list all jobs but `update`/`delete`/`run`/`toggle` only touch `managed: "agent"` entries — operator jobs are read-only to the agent.

Responses include `firesAt` (UTC ISO), `firesAtLocal` — the fire time rendered in `timezone` with its GMT offset **and** IANA zone name (e.g. `Nov 12, 2026, 6:00 PM GMT-3 (America/Argentina/Buenos_Aires)`) — and `now`, the current time in the same format, so the agent can resolve "tomorrow 18hs"-style requests without guessing your clock.
