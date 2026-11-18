# Chat commands

← Back to [README](../README.md)

Both Telegram and Discord support these commands. The bridge intercepts them before forwarding to the agent.

## Task control

| Command | Description |
|---|---|
| `/stop` | Cancel the current task (sends `session/cancel` to the agent) |
| `/queue` | List pending prompts waiting in the queue |
| `/queue rm <n>` | Remove the pending prompt at position `n` |
| `/queue clear` | Remove all pending prompts |
| `/status` | Bridge version + uptime, agent state/mode, agent command, session ID (with title when the agent lists it), queue + jobs summary (next fire), last prompt error, and A2A peer counts when enabled |
| `/time` | Show the three clocks: host system zone, configured `timezone`, and UTC |

## Sessions

| Command | Description |
|---|---|
| `/sessions` | List available sessions as a numbered list — title + age (requires agent `session/list` capability) |
| `/sessions new` | Start a fresh session (clears accumulated context) |
| `/sessions <n>` | Switch to a session by its number in the last `/sessions` list |
| `/sessions <id>` | Switch to a session by literal id (full or unique prefix) |
| `/sessions rm <n\|id>` | Delete a session (requires agent `session/delete` capability) |

## Config

| Command | Description |
|---|---|
| `/config` | List session config options reported by the agent (model, mode, thought level, etc.) |
| `/config <id>` | Show the selectable values for an option, numbered |
| `/config <id> <n>` | Set an option by picking a number from its list |
| `/config <id> <value>` | Set an option via `session/set_config_option` (value ID, or `true`/`false` for boolean options) |

`/config` is the single settings surface: agents that expose session modes only via `session/set_mode` (not as a config option) get a synthetic `mode` option automatically — a real `mode` config option always wins. There are no separate `/mode` or `/model` commands.

`/sessions new` and `/sessions <n|id>` are refused while the agent is busy — use `/stop` first. `/sessions` gracefully degrades with an error message if the agent doesn't support `session/list`. `/sessions rm` cannot delete the active session (use `/sessions new` first). `/config` reports "No config options reported by the agent" if the agent exposes neither `configOptions` nor modes.

`/help` lists only the built-in bridge commands. Slash commands the agent advertises via `available_commands_update` are not shown in `/help`, but typing an agent command still forwards it to the agent as a prompt.

### Initial session mode

Set `sessionMode` in the config to apply a mode automatically when a session is created or loaded:

```jsonc
{
  "agentCmd": "devin acp",
  "sessionMode": "bypass"
}
```

This calls `session/set_mode` after `session/new`, `session/load`, or `session/resume`. The mode ID is agent-specific — Devin supports `accept-edits`, `smart`, `ask`, `plan`, and `bypass`. Other agents may expose different modes.

## Jobs

All scheduled and manual prompts — one namespace for what used to be cron, routines and reminders:

| Command | Description |
|---|---|
| `/jobs` | List all jobs — numbered, with type (⏰ once / 🔁 cron / ⚡ manual), owner (🤖 agent) and fire time |
| `/jobs add [as <name>] <when> <prompt>` | Create a job |
| `/jobs run <n\|name>` | Run a job now (manual jobs require this) |
| `/jobs <n\|name>` | Bare reference also runs the job (picker UX) |
| `/jobs toggle <n\|name>` | Pause/resume a job |
| `/jobs rm <n\|name>` | Delete a job (`delete`/`remove` aliases) |

`<when>` accepts:

| Form | Example | Creates |
|---|---|---|
| `in <dur>` / `in <n> <unit>` | `in 20m`, `in 2 hours` | once job |
| `every <dur>` | `every 1h`, `every 30m` | recurring (compiled to cron) |
| natural/absolute | `friday 9am`, `2026-11-20 18:00`, `tomorrow 18hs` | once job (needs `timezone` or explicit offset) |
| 5-field cron | `0 9 * * 1-5` | recurring |
| `manual` | `as briefing manual summarize my day` | manual job — **requires `as <name>`** |

`as <name>` optionally prefixes any job type so you can reference it by name later. Numeric refs (`/jobs run 2`) resolve against the last `/jobs` listing (10-minute cache); names work anytime. Absolute times without an explicit zone resolve in `config.timezone` — check `/time` if you're unsure which clock you're on.

Operator jobs fire verbatim with operator authority. Agent-created jobs (🤖) are capped at 50 and fire as remote content — their prompts never run bridge commands.

## Execution

| Command | Description |
|---|---|
| `/start` | Show welcome message with command list |
| `/help` | Show welcome message with command list |

Any other message (including unknown `/commands`) is forwarded directly to the agent.

`/stop` cancels the in-progress prompt turn and clears the pending queue. The agent receives a `session/cancel` notification and should respond with a `cancelled` stop reason.
