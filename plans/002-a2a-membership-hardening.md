# Plan 002: A2A membership hardening — confirm never escalates status + announce identity binding

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 1ab07fe..HEAD -- src/a2a.ts src/a2a-manager.ts src/network.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (operator path remains the only approval path; see compat notes)
- **Depends on**: plans/001-a2a-peer-auth.md (benefits from its signature
  plumbing, but its own fixes are independent of it)
- **Category**: security
- **Planned at**: commit `1ab07fe`, 2026-11-08
- **Tracked as**: SEC-01 (Option A+D) and SEC-05 in `docs/security-audit-2026-10-21.md`

## Why this matters

Two unauthenticated endpoints grant or redirect trust:
1. `POST /a2a/confirm {"id":"x"}` — an anyone-callable endpoint that flips a
   pending peer to approved. An attacker joins (creating a pending record)
   and immediately self-confirms, bypassing the owner approval entirely.
2. `POST /a2a/registry/announce` — any caller may overwrite an *approved*
   peer's `cardUrl`/`card`. The next delegation POSTs task text to that URL
   (SSRF + task exfiltration) and `refreshPeerCard` fetches it on a timer.

Fix: operator approval becomes the only path to `approved` (confirm becomes
informational), and announce can only refresh `lastSeen` unless the caller
proves peer identity (HMAC from plan 001) or stays same-origin.

## Current state

- Confirm endpoint, unauthenticated (`src/a2a.ts:126-137`):
  ```ts
  if (req.method === 'POST' && url.pathname === '/a2a/confirm') {
    const body = await readBody(req);
    const confirm = JSON.parse(body) as { id?: string };
    ...
    await this.opts.onConfirm?.(confirm.id);
  ```
- Status escalation on remote input (`src/a2a-manager.ts:115-124`):
  ```ts
  async handleConfirm(peerId: string): Promise<void> {
    const peer = this.network.getPeer(peerId);
    if (peer && peer.status === 'pending') {
      this.network.setStatus(peerId, 'approved');   // ← remote input grants trust
  ```
- Registry announce rewrite, no caller identity check (`src/a2a.ts:215-235`):
  ```ts
  const peer = announce.id ? this.opts.network.getPeer(announce.id) : undefined;
  if (peer?.status !== 'approved') { /* 403 */ }
  if (announce.cardUrl) peer.cardUrl = announce.cardUrl;
  if (announce.card) peer.card = announce.card;
  ```
- Delegation uses `peer.cardUrl` (`src/a2a.ts:353`):
  `const origin = new URL(peer.cardUrl).origin;`
- `_setStatus` approve posts confirm to the peer (`src/a2a-manager.ts:275-284`).
- Registry-mode note: ADR-style comment at `src/a2a.ts:182-188` states the
  registry is discovery-only and "never sees task content" — keep that wording
  in any comment you touch.
- Exemplar tests: `test/a2a.test.ts`, `test/a2a-edge.test.ts`,
  `test/a2a-manager.test.ts`. Repo text in English.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Tests     | `pnpm test -- a2a`       | all pass            |
| Typecheck | `pnpm typecheck`         | exit 0              |
| Lint      | `pnpm lint`              | exit 0              |

## Scope

**In scope**:
- `src/a2a.ts` (confirm endpoint response handling, announce authorization)
- `src/a2a-manager.ts` (`handleConfirm`, audit/notify on confirmation)
- `test/a2a*.test.ts`, `test/network.test.ts` (extend)

**Out of scope**:
- `trustedPeers` pre-approval behavior (tracked separately).
- `_handleRpc` message/send authorization (plan 001).
- `joinPeer`/`handleJoinRequest` flow shapes beyond what the compatibility
  note below requires.
- Removing the `/a2a/confirm` endpoint (upstream peers still call it; it
  stays as an informational ack).

## Git workflow

- Branch: `advisor/002-a2a-membership`
- Conventional commits, e.g. `fix(a2a): operator approval is the only path to approved`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `handleConfirm` stops granting trust

Rewrite `src/a2a-manager.ts` `handleConfirm` (keep the `peerSecret?: string`
optional param added by plan 001 if it already landed — both plans may apply;
if plan 001 has not landed, keep the current single-param signature):

```ts
async handleConfirm(peerId: string, peerSecret?: string): Promise<void> {
  const peer = this.network.getPeer(peerId);
  this.network.touchPeer?.(peerId);            // or set lastSeen inline if no helper
  this.audit?.write({ event: 'peer_confirmed_by_peer', peer: peerId });
  if (!peer || peer.status !== 'approved') {
    // informational only — never mutate trust from remote input
    await this.notify(`ℹ️ ${peerId} acknowledged our join request (status unchanged: ${peer?.status ?? 'unknown'}).`);
    return;
  }
  ... existing lastSeen/notify path ...
}
```

Requirements:
- No call to `setStatus(peerId, 'approved')` anywhere reachable from
  `onConfirm`/`handleConfirm`.
- Keep the `notify()` UX so operators still learn the peer confirmed.
- `setStatus` transitions (`src/network.ts:35-41`) stay unchanged —
  approval still happens via `_setStatus` (operator `/a2a approve`).

**Verify**: `pnpm test -- a2a-manager` — existing tests asserting
`pending → approved` via confirm must be rewritten to the new expectation
(status unchanged); rewrite is expected, assertion of the *security* property
is mandatory (see Test plan).

### Step 2: Announce authorization

In `src/a2a.ts` `_handleRegistry` announce branch (`a2a.ts:215-235`), replace
the unconditional rewrite with:

1. Peer must be `approved` (unchanged).
2. Identity binding, best available in order:
   - If the caller presents a valid `x-a2a-peer-signature` (plan 001) that
     verifies against the peer's `auth.secret` → full update allowed
     (`cardUrl`, `card`, `lastSeen`).
   - Else if `isLoopback(req.socket.remoteAddress)` (`src/a2a.ts:468-470`)
     → full update allowed (local operator tooling on the same host).
   - Else (unauthenticated remote caller) → update `lastSeen` only, write
     audit `{ event: 'announce_rejected', peer: announce.id, detail: 'unauthenticated' }`,
     respond `403 { error: 'signature or loopback required for card updates' }`.
3. Additionally, when a remote signed update changes `cardUrl`, sanity-check
   the new URL with `new URL(...)` and require protocol `http:`/`https:`
   (invalid → 400, no state change).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test -- a2a` → all pass
(update/extend the announce tests accordingly).

### Step 3: Regression tests

Add to `test/a2a-edge.test.ts` (match the existing in-process server pattern):
- `postConfirm then join does not approve a pending peer` — the audit's exact
  attack sequence: join creates pending, confirm must leave `status: 'pending'`
  (assert via the network store, not just HTTP status).
- `only the operator path approves` — `/a2a approve <id>` → peer approved;
  equivalent confirm-only sequence → still pending.
- `unauthenticated announce cannot change cardUrl` — POST announce without
  signature from a non-loopback fake remote; assert `peer.cardUrl` unchanged
  in the store and HTTP 403.
- `signed announce updates card` (when plan 001 landed) or `loopback announce
  updates card` (when 001 is pending).

Verification: `pnpm test -- a2a` → all pass, including these.

## Test plan

- Structural pattern: `test/a2a-edge.test.ts` in-process server + `NetworkStore`
  against a temp file.
- Also update `test/a2a-manager.test.ts` confirm-related suites to the new
  semantics (status unchanged on confirm; approval only via `_setStatus`).

## Compatibility note (document in PR description — do not put in code)

Today, an outgoing `/a2a join` completed by the *far side's owner* is the only
legit flow that could reach `handleConfirm` with a locally-`pending` record.
After this change, the operator must still run `/a2a approve <id>` locally in
that flow — this is exactly the audit's adopted Option A+D ("trust granted
only by the operator"). The far side keeps its own approval state. Mention
in the release CHANGELOG: "`/a2a/confirm` no longer auto-approves; run
`/a2a approve` to complete both sides."

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; the four regression tests above pass
- [ ] `grep -n "setStatus(peerId" src/a2a-manager.ts` returns no hits inside `handleConfirm`
- [ ] `grep -n "peer.cardUrl = announce.cardUrl" src/a2a.ts` exists only inside the
      signed-or-loopback branch
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- `test/a2a-manager.test.ts` contains a test proving a documented, deliberate
  flow *requires* remote-confirm escalation (then the A+D decision must be
  revisited by the operator before proceeding).
- Plan 001 has not landed and you cannot implement Step 2's signature branch —
  implement the loopback branch + lastSeen-only fallback and note it in the
  status row ("announce signed branch deferred to 001").
- The drift check shows in-scope files changed (plans 001 may have rewritten
  the same functions — coordinate instead of overwriting).

## Maintenance notes

- Reviewer should scrutinize: no remaining `setStatus(..., 'approved')` call
  site reachable from network input; announce cannot write `card` either.
- The once-a-release follow-up is the CHANGELOG migration wording (plan 005).
- If a standardized A2A auth lands ecosystem-wide, revisit the loopback
  fallback in Step 2.
