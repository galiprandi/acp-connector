# Plan 004: Agent-scheduled cron jobs are remote content — never run bridge commands, capped, and not persisted into operator config

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 1ab07fe..HEAD -- src/reminders-api.ts src/cron.ts src/bridge.ts src/base-bot.ts src/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Note: plan 003 also touches
> `base-bot.ts:491-496` — apply on top of it or coordinate (see STOP).

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (narrow behavior change for agent-created jobs with `/`-prompts)
- **Depends on**: none (orthogonal to plan 001/002; shares `base-bot.ts` with plan 003)
- **Category**: security
- **Planned at**: commit `1ab07fe`, 2026-11-08
- **Tracked as**: new (not in the 2026-10-21 audit — surfaced by this review)

## Why this matters

The agent-facing MCP server (`/cron/create`, loopback API) lets the agent
persist a job with an arbitrary `prompt` string. Those prompts are persisted
into the operator's `acp-connector.jsonc` and fire via the cron manager with
`source: 'cron'` — a first-class entry point that *passes* the bridge command
gate. A prompt starting with `/` (e.g. `/a2a approve attacker`) executes as a
bridge command at fire time, with operator authority, surviving restarts.
This is the sole path where agent-chosen text reaches the command dispatcher
(agent message output itself is inert). Fix: agent-managed (`managed:
'agent'`) job firings are treated as remote content (like `source: 'a2a'`),
agent-created jobs are capped, and agent prompts get the same
delivery-prefix guard reminders already use.

## Current state

- Agent cron creation persists into operator config (`src/reminders-api.ts:172-183`):
  ```ts
  if (path === '/cron/create' && req.method === 'POST') {
    const body = await _readBody(req);
    const prompt = _str(body.prompt);
    ...
    const id = `agent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const job = cronManager.add({ name: id, schedule, prompt, managed: 'agent' });
    if (!job) return _err(res, 'invalid schedule or duplicate job');
    persistCronAndRoutines(cronManager.list());   // writes acp-connector.jsonc
  ```
- Job fires enqueue verbatim (`src/cron.ts:122-124`):
  ```ts
  const task = cron.schedule(job.schedule, () => {
    this.onLog(`⏰ cron "${job.name}" fired`);
    this.enqueue(job.prompt, chatId);
  });
  ```
- Wiring tags them `source: 'cron'` (`src/bridge.ts:68`):
  ```ts
  bot.enqueuePrompt(text, chatId, undefined, undefined, 'cron');
  ```
- The command gate treats `'cron'` as privileged (`src/base-bot.ts:491-496`):
  ```ts
  const isRemoteContent = source === 'a2a';
  if (!isRemoteContent && (await this._handleBuiltinCommand(text, chatId))) return;
  ```
- Reminders already have the correct pattern — delivery-time prefix guard
  (`src/reminders.ts:363`, `[Reminder <id>]` prefix).
- Reminder cap for contrast (`src/reminders.ts:22-23`, `MAX_REMINDERS = 50`);
  agent cron jobs have no cap.
- Exemplar tests: `test/cron.test.ts`, `test/cron-edge.test.ts`,
  `test/reminders-api.test.ts`, `test/loopback.test.ts`. Repo text in English.

## Commands you will need

| Purpose   | Command                    | Expected on success |
|-----------|----------------------------|---------------------|
| Test one  | `pnpm test -- cron`        | all pass            |
| Tests     | `pnpm test`                | all pass            |
| Typecheck | `pnpm typecheck`           | exit 0              |
| Lint      | `pnpm lint`                | exit 0              |

## Scope

**In scope**:
- `src/reminders-api.ts` (cron/create cap; prompts kept as-is)
- `src/cron.ts` (source differentiation at fire time)
- `src/bridge.ts` (wiring — pass agent-vs-operator marker)
- `src/base-bot.ts` (command gate computation, coordinated with plan 003)
- `src/config.ts` (only if the cron job type gains a field — see Step 1)
- `test/cron*.test.ts`, `test/reminders-api.test.ts`, `test/base-bot`-related
  suites (extend)

**Out of scope**:
- The reminder (`reminder_*`) path — already prefix-guarded; do not touch.
- Removing `persistCronAndRoutines` or changing where operator jobs persist.
- The MCP tool surface (`src/reminders-mcp.ts`) — its HTTP backing is in scope.
- Changing operators' existing `/cron add` flows in any way.

## Git workflow

- Branch: `advisor/004-agent-cron-invariant`
- Conventional commits, e.g. `fix(cron): agent-managed cron fires are remote content`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Source differentiation at fire time

`CronJob` types where structurally defined (check `src/config.ts` `CronJob`
around line 113 and the `cron.ts` import of it). The gate must distinguish
operator jobs (`/cron add`, config-defined) from agent jobs
(`managed === 'agent'`). Options, in order of preference:

1. If `CronJob` already has `managed?: 'agent' | 'operator'` (confirmed
   referenced at `src/reminders-api.ts:105,166` and `src/config.ts` job type) —
   no type change needed.
2. `src/bridge.ts:68` wiring — the callback currently receives `(text,
   chatId)`; extend the `CronManager` `enqueue` callback signature to pass the
   job (or a `managed` boolean): `enqueue(text, chatId, managed)`. Then:
   ```ts
   bot.enqueuePrompt(text, chatId, undefined, undefined,
     managed ? 'agent-cron' : 'cron');
   ```
3. `src/base-bot.ts` `enqueuePrompt` source union (line 484) gains
   `'agent-cron'`, and the remote-content computation becomes (post-plan-003):
   ```ts
   const isRemoteContent =
     source === 'a2a' ||
     (source === 'http' && !this.httpCommandsAllowed) ||
     source === 'agent-cron' || source === 'reminder'; // reminder prefix glut
   ```
   `reminder` already cannot reach commands via its prefix, but listing it
   keeps the gate self-documenting — if plan 002 landed differently, match
   what is in the file at execution time (coordinate, don't duplicate).

Also apply the reminder-style delivery guard for agent jobs at fire time:
in `cron.ts`, when the job is `managed === 'agent'`, enqueue
`[Agent cron ${job.name}] ${job.prompt}` — same pattern as
`src/reminders.ts:363` — so a leading `/` is never parsed even by future gates.

**Verify**: `pnpm test -- cron` — add: `agent-managed job with prompt "/a2a approve x" does not run bridge commands` (assert via a fake command handler not being called and/or network store unchanged) and `operator job with "/routine list" still runs commands`.

### Step 2: Cap agent-created jobs

In `src/reminders-api.ts` `/cron/create` (line 172-183), before creating:

```ts
const AGENT_CRON_CAP = 50; // mirrors MAX_REMINDERS in reminders.ts
const agentJobs = cronManager.list().filter((j) => j.managed === 'agent').length;
if (agentJobs >= AGENT_CRON_CAP) {
  return _err(res, `agent cron job cap reached (${AGENT_CRON_CAP})`);

}
```

Export `AGENT_CRON_CAP` for reuse/testing; operator-created jobs are not
capped (834-type cap belongs to operator policy, out of scope).

**Verify**: `pnpm test -- reminders-api` — new test pushes `AGENT_CRON_CAP` fake
jobs and asserts the 400 error message.

### Step 3: Config persistence honesty

`persistCronAndRoutines` (`src/routines.ts:11-17`) keeps writing agent jobs to
`acp-connector.jsonc` so they survive restarts (documented behavior — the
agent's scheduled prompts persisting is a feature). Two additive changes:

- In the config write, keep agent jobs but ensure the comment block the config
  writer emits (if any) flags them as agent-owned; only do this if such a
  comment mechanism already exists — do NOT invent file-format changes.
- No other change here; state files stay as-is.

**Verify**: `pnpm test -- routines` → all pass (no expectations change).

## Test plan

- Structural pattern: `test/cron-edge.test.ts` (fixture-based cron schedules)
  plus `test/reminders-api.test.ts` HTTP harness.
- New cases: listed in Steps 1–2; plus one full-chain regression:
  `POST /cron/create from the MCP path with prompt "/a2a approve x" does not
  mutate network state at fire time` — create job via the API, fire the
  schedule manually via fixture, assert `network.isApproved('x')` false.
- Update any test asserting agent cron prompts reach `_handleBuiltinCommand`.

Verification: `pnpm test` → all pass.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; all new tests above exist and pass
- [ ] `grep -n "persistCronAndRoutines(cronManager.list())" src/reminders-api.ts` unchanged behavior (calls still present — feature kept)
- [ ] `grep -n "agent-cron" src/base-bot.ts src/bridge.ts` shows the new source value and gate branch
- [ ] `grep -n "AGENT_CRON_CAP" src/reminders-api.ts` present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- plan 003 landed and `base-bot.ts:491-496` already restructured the gate —
  integrate with its shape; if ambiguous which file owns the final form,
  report.
- `CronJob` has no `managed` field reachable at fire time (then extend the
  job creation in `cronManager.add` to carry it — if that forces touching
  `src/reminders-mcp.ts`, report instead).
- `persistCronAndRoutines` turns out to reject `managed: 'agent'` markers —
  report rather than inventing a config format change.

## Maintenance notes

- The `[Agent cron <name>]` prefix must stay stable — README/docs should not
  depend on its exact shape but tests do.
- If `/cron` command gains agent-job listing/dialing UX later, re-check the cap.
- Reviewer scrutiny: operator `/cron add` jobs must be byte-for-byte unchanged
  in persistence and gate behavior.
