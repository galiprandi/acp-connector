# Plan 003: Hardened HTTP `/prompt` — auth fail-closed, command gate behind `http.commands`, validated `callbackUrl`/`chatId`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 1ab07fe..HEAD -- src/http.ts src/base-bot.ts src/bridge.ts src/config.ts acp-connector.example.jsonc`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (three behavior changes for existing deployments; all
  recoverable via config — documented in the migration table in plans/005)
- **Depends on**: none (do before plans/005 so the CHANGELOG ships with it)
- **Category**: security
- **Planned at**: commit `1ab07fe`, 2026-11-08
- **Tracked as**: SEC-03 + SEC-04 (callbackUrl half) in `docs/security-audit-2026-10-21.md`

## Why this matters

The optional HTTP server is an admin surface today:
1. `authToken` defaults to `null` and the auth check is skipped entirely when
   unset (`if (this.authToken && ...)`), even when the server binds beyond
   loopback — unauthenticated prompt injection into the coding agent.
2. Prompts enqueued with `source: 'http'` are fed into the bridge command
   dispatcher (`_handleBuiltinCommand` and the `/a2a` family), so
   `POST /prompt {"text":"/a2a approve attacker"}` mutates network trust with
   no operator involvement — the invariant "remote content never triggers
   bridge commands" holds for `source:'a2a'` but not for tokenless `'http'`.
3. `callbackUrl` from the request body is fetched unvalidated, POSTing the
   agent's full response to any URL (SSRF + exfiltration).
4. `chatId` from the body is trusted — replies can be delivered to channels
   outside `allowedChatIds`.

## Current state

- Auth opt-in (`src/http.ts:127-131`):
  ```ts
  // Auth check
  if (this.authToken && !this._checkAuth(req)) {
    res.writeHead(401); ...
  ```
  Token arrives from config with no presence check: `src/bridge.ts:255`
  (`authToken: config.http?.auth?.token || null`, exact line verified 251-255).
- Command gate treats `'http'` as trusted (`src/base-bot.ts:491-496`):
  ```ts
  const isRemoteContent = source === 'a2a';
  if (!isRemoteContent && (await this._handleBuiltinCommand(text, chatId))) return;
  ```
- Unvalidated webhook (`src/http.ts:266-278`):
  ```ts
  if (callbackUrl) {
    onComplete = (response: string, error?: string) => {
      fetch(callbackUrl, { method: 'POST', ... })
  ```
- Trusted chatId (`src/http.ts:199`):
  `chatId = typeof data.chatId === 'number' ? data.chatId : undefined;`
- Non-constant-time token compare (`src/http.ts:289-293`):
  `return auth === \`Bearer ${this.authToken}\`;`
- Config surface (`src/config.ts:24-34`) — `HttpConfig` grows:
  `commands?: boolean` and `callbackAllow?: string[]`.
- Exemplar tests: `test/http-security.test.ts`, `test/http-edge.test.ts`,
  `test/http.test.ts` — extend these; repo text in English.

## Commands you will need

| Purpose   | Command                    | Expected on success |
|-----------|----------------------------|---------------------|
| Test one  | `pnpm test -- http`        | all pass            |
| Tests     | `pnpm test`                | all pass            |
| Typecheck | `pnpm typecheck`           | exit 0              |
| Lint      | `pnpm lint`                | exit 0              |

## Scope

**In scope**:
- `src/http.ts`, `src/config.ts` (`HttpConfig`), `src/bridge.ts` (wiring),
  `src/base-bot.ts` (enqueuePrompt signature/docstring only — see Step 3)
- `acp-connector.example.jsonc`
- `test/http*.test.ts`, `test/bridge.test.ts`, `test/loopback.test.ts` (extend)

**Out of scope**:
- `a2a.secure` (plan 001) and A2A endpoints entirely.
- Error-message minimization (returning `(err).message` to clients) and
  consumer-side rate limiting — tracked separately in the audit doc.
- Cron/reminder sources treatment (plan 004).

## Git workflow

- Branch: `advisor/003-http-prompt-hardening`
- Conventional commits, e.g. `fix(http): fail closed when http.host is not loopback and no auth token is set`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fail closed at startup without a token on non-loopback bind

In `src/bridge.ts`, where the `HttpServer` is constructed (verified at
`src/bridge.ts:251-255`), before creating the server:

```ts
const httpHost = config.http?.host ?? '127.0.0.1';
const isLoopback = ['127.0.0.1', '::1'].includes(httpHost) || httpHost.startsWith('127.');
if (config.http?.enabled && !isLoopback && !config.http?.auth?.token) {
  throw new Error(
    'http.enabled with a non-loopback host requires http.auth.token — refusing to start (set http.auth.token or bind http.host to 127.0.0.1)'
  );
}
if (config.http?.enabled && isLoopback && !config.http?.auth?.token) {
  log.warn('HTTP server enabled without an auth token — any local process can inject prompts and run bridge commands');
}
```

Match existing early-exit/validation style in `bridge.ts` constructor.
Reuse a small local helper; do not import `src/a2a.ts` `isLoopback` (avoid a
cross-module dependency two servers share — copy the 4-line predicate, or
factor it into `src/http.ts` and export it, prefer the export).

**Verify**: `pnpm test -- bridge` — add a unit test that bridge construction throws
with `http.enabled + host:"0.0.0.0"` and no token, and that with
`http.auth.token` set it does not throw.

### Step 2: Command gate behind `http.commands`

- `src/config.ts` `HttpConfig` (line 24): add
  `/** Allow /commands (e.g. /a2a, /mode, /cron) to be run via POST /prompt. Default false: prompt text sent over HTTP is agent input, never bridge administration. */ commands?: boolean;`
- `src/bridge.ts:261`: `enqueuePrompt(text, chatId, blocks, onComplete, 'http', ...)`
  — the command gate lives in `base-bot.ts`; change the gate instead of the
  source tag so audit/log strings keep working:
- `src/base-bot.ts:491-496`: the gate becomes source-driven:

  ```ts
  const commandPrivileged =
    !source || source === 'cron-operator' || source === 'routine'; // see plan 004 for cron split
  ```

  with the HTTP case expressed as a passed-in flag. Concretely: add an
  optional `httpCommandsAllowed?: boolean` property on BaseBot options
  (wired from `config.http?.commands ?? false`) and compute:

  ```ts
  const isRemoteContent = source === 'a2a' || (source === 'http' && !this.httpCommandsAllowed);
  ```

  Keep `'http'` prompts flowing to the agent always; when treated as remote
  content they skip `_handleBuiltinCommand` and `onCommand`.
- If `echoInjectedPrompts` renders `[http]` prefixed echoes, unchanged.

**Verify**: `pnpm test -- base-bot` — add: `POST /prompt with text "/a2a approve x" does not change peer status by default`; add the negative: same with `http.commands: true` wired in options → command path runs (assert via the onCommand handler double or member mutation through a fake).

### Step 3: Validate `callbackUrl` and `chatId`

In `src/http.ts` `_handlePrompt`:

- After parsing `callbackUrl` (line 190-200):
  ```ts
  if (callbackUrl && !this._isCallbackAllowed(callbackUrl)) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'callbackUrl rejected' })); return;
  }
  ```
  `_isCallbackAllowed`: `new URL()` succeeds (catch → false), protocol is
  `http:`/`https:`, hostname is not `127.0.0.1`/`::1`/`localhost`, and
  allowed-escape-hatch: if `callbackAllow` list (from options, default `[]`)
  contains the hostname, private/local ranges are permitted.
- `chatId`: only honor the body value when it is present in an allowlist —
  BaseBot already knows `allowedChatIds`; expose a predicate via the existing
  `enqueue` wiring instead (simplest: bridge.ts validates at line 255-263
  before calling `bot.enqueuePrompt`):
  ```ts
  const chatAllowed = (id: number) => bot.allowedChatIds.includes(id);
  enqueue text with: data.chatId === undefined ? undefined : (chatAllowed(data.chatId) ? data.chatId : undefined)
  ```
  Drop silently with a `log.warn` when a body `chatId` is dropped.

**Verify**: `pnpm test -- http` — new tests: `rejects callbackUrl pointing to loopback`, `allows callbackUrl when listed in callbackAllow`, `drops a chatId not in the platform allowlist`.

### Step 4: Constant-time token compare

In `src/http.ts` `_checkAuth` (289-293):

```ts
_checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${this.authToken}`;
  const a = Buffer.from(auth); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

(`import { timingSafeEqual as _ts } from 'node:crypto'` per repo import style —
match biome organize-imports output.)

**Verify**: `pnpm test -- http-security` → all pass (existing auth tests keep passing;
add none — behavior is identical for valid/invalid lengths).

### Step 5: Example config + docs hooks

- `acp-connector.example.jsonc` http section: add commented
  `"commands": false` and `"callbackAllow": []` entries explaining defaults.
- README hit points (keep edits short; full migration table lives in plan 005):
  - in the HTTP API section: "POST /prompt sends agent input. To run bridge
    commands set `http.commands: true`."
  - note: server refuses external bind without `http.auth.token`.

**Verify**: `grep -n "commands" acp-connector.example.jsonc` → present.

## Test plan

- Structural pattern: `test/http-security.test.ts` (in-process server, fake
  enqueue callback — reuse its harness).
- New cases listed inline in Steps 1–4.
- Update any existing test that relies on `/prompt` running commands — assert
  the new two-tier behavior instead of deleting the assertion.

Verification: `pnpm test` → all pass.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; all new tests above exist and pass
- [ ] `grep -n "if (this.authToken &&" src/http.ts` returns no hits (fail-closed token handling done via bridge throw + `?? ''` compare)
- [ ] `grep -n "commands" src/config.ts` shows the new HttpConfig field
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- Existing tests depend on `source: 'http'` commands in ways Step 2 cannot
  express without touching `loopback.ts` — report (do not queue a second
  gate change; `loopback` headless bot command gating is operator-internal
  and intentionally unchanged).
- `chatId` allowlist info is not accessible from bridge wiring as assumed
  (BaseBot member names differ) — report the actual field names instead of
  guessing.
- The fail-closed throw breaks startup paths used in tests temporarily —
  coordinate with loopback/headless fixtures rather than weakening the check.

## Maintenance notes

- Reviewer scrutiny: default paths must be secure — no config-combination
  where commands run without explicit operator opt-in from BOTH
  (`http.commands: true`) AND an existing deployment's own choice of transport
  trust.
- `callbackAllow` list is a raw-string allowlist of hostnames; if the URL
  parser normalizes differently than expected in tests, report exact strings.
- Deferred: response error-body minimization, per-IP limits on `message/send`
  consumer endpoints, and DNS-rebinding `Host` checks — all tracked in the
  audit doc, not here.
