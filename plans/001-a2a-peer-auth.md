# Plan 001: Authenticated A2A peer transport (per-pairing secret + HMAC, `a2a.secure` mode)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 1ab07fe..HEAD -- src/a2a.ts src/a2a-manager.ts src/network.ts src/config.ts src/bridge.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (protocol change; mitigated by legacy-accepting transition below)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1ab07fe`, 2026-11-08
- **Tracked as**: SEC-02 in `docs/security-audit-2026-10-21.md` (WP-08 / WP-02)

## Why this matters

A2A `message/send` and `registry/announce` trust a self-asserted header
(`x-a2a-peer-id`) checked against the local peer list. Peer ids are public
(they appear in agent cards, `/a2a/peers`, mDNS, and `network.json`), so when
the A2A endpoint is bound beyond loopback (`a2a.host: "0.0.0.0"` is documented
for LAN/container use) any host on the network can impersonate an approved
peer by setting one header — approved-peer lists provide no real
authentication. This plan gives each pairing a random shared secret and a
HMAC verification layer, opt-in via `a2a.secure: true`, with a legacy
transition so mixed-version meshes keep working.

## Current state

- `src/network.ts` — `NetworkStore` persists peers to `.acp-connector/network.json`.
  Peer record has no auth material today:
  ```ts
  // src/network.ts:18-26
  export interface Peer {
    id: string;
    cardUrl: string;
    status: PeerStatus;
    source: PeerSource;
    card?: Record<string, unknown>;
    joinedAt?: string;
    lastSeen?: string;
  }
  ```
  `NETWORK_SCHEMA_VERSION = 1` (`src/network.ts:11`); adding an optional field
  does not require a schema bump.
- `src/a2a.ts:10` — `export const PEER_ID_HEADER = 'x-a2a-peer-id';`
- `src/a2a.ts:259-269` — the only gate for `message/send`:
  ```ts
  const peerId = String(req.headers[PEER_ID_HEADER] ?? '');
  if (!peerId || !this.opts.network.isApproved(peerId)) { /* reject */ }
  ```
- `src/a2a.ts:333-383` — `_handleDelegate` sends outbound with
  `headers: { 'Content-Type': 'application/json', [PEER_ID_HEADER]: this.opts.selfId }`.
- `src/a2a-manager.ts:275-286` — on operator `/a2a approve`, the bridge POSTs
  `{ id: this.selfId }` to the peer's `/a2a/confirm`.
- `src/a2a-manager.ts:186-193` — `announceToRegistry` sends `{ id, cardUrl, card }`
  with no signature.
- `src/config.ts:58-74` — `A2aConfig` (add `secure?: boolean` here).
- Exemplar style: `src/network.ts` (typed interfaces + small mutating methods +
  `save()`), Vitest suites `test/network.test.ts`, `test/a2a.test.ts`,
  `test/a2a-edge.test.ts`. All repo text (code, tests, comments, docs) in English.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install`           | exit 0              |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Tests     | `pnpm test -- network`   | all pass            |
| Lint      | `pnpm lint`              | exit 0              |

## Scope

**In scope**:
- `src/network.ts` (Peer type + auth helpers)
- `src/a2a.ts` (verify inbound, sign outbound)
- `src/a2a-manager.ts` (secret generation/delivery on approve)
- `src/config.ts` (`A2aConfig.secure`)
- `src/bridge.ts` (wiring only if a constructor arg must change)
- `test/network.test.ts`, `test/a2a.test.ts`, `test/a2a-edge.test.ts` (extend)

**Out of scope**:
- `/a2a/confirm` status semantics and registry `announce` authorization —
  handled in plans/002; do not change behavior there beyond adding the
  signature plumbing it may consume.
- `trustedPeers` handling (a related password-less-account gap, tracked
  separately in the audit doc — note it, don't change it).
- Any change to the A2A JSON-RPC request/result shapes.

## Git workflow

- Branch: `advisor/001-a2a-peer-auth`
- Commits in conventional style (`feat(a2a): ...`), each step or logical unit
  (example from log: `fix(setup): add ~/.opencode/bin to PATH when re-detecting after install`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Store a pairing secret in the Peer record

In `src/network.ts`, extend `Peer` with:

```ts
/** Secret this bridge expects FROM this peer when it signs requests to us. */
auth?: { secret: string; issuedAt: string };
```

Add methods to `NetworkStore`:

- `issuePeerAuth(id: string): string` — via `crypto.randomBytes(24).toString('hex')`;
  store in `peer.auth`, call `save()`, return the secret. Idempotent: if
  `peer.auth?.secret` exists, return it unchanged (never rotate silently —
  a rotation should be an explicit `/a2a` operator action later, out of scope).
- `verifyPeerSignature(id: string, body: string, signatureHex: string): boolean` —
  `crypto.createHmac('sha256', peer.auth.secret).update(body).digest('hex')`
  compared with `crypto.timingSafeEqual` over length-normalized buffers
  (return `false` if either side lacks the prerequisite). Returns `false`
  when the peer has no `auth`.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test -- network` → all pass.

### Step 2: Deliver the secret at pairing time

In `src/a2a-manager.ts` `_setStatus` approve branch (`a2a-manager.ts:275-286`):
before the confirm POST, call `this.network.issuePeerAuth(id)` and include
`secret` in the confirm body:

```ts
const secret = this.network.issuePeerAuth(id);
body: JSON.stringify({ id: this.selfId, peerSecret: secret }),
```

Inbound confirm handling (`handleConfirm`) gains an optional second param
`peerSecret?: string`; when present and the peer has no `auth` yet, store it
with `this.network.upsertPeer` / a small direct assignment (this is the far
side's secret used to sign to us — mirrored store, same struct).
`src/a2a.ts` passes the already-parsed body field through
`opts.onConfirm?.(confirm.id, confirm.peerSecret)`.

Pairing tokens cross the network once, in the approve→confirm POST. Document
in the plan summary that a first-message MITM sees the pairing token; this is
accepted for LAN deployments without TLS.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass (flow changed for
existing a2a-manager tests: update the confirm-body assertions if any assert
the exact body).

### Step 3: Verify inbound signatures

In `src/a2a.ts`:

- New constant: `export const PEER_SIGNATURE_HEADER = 'x-a2a-peer-signature';`
- In `_handleRpc` (message/send, `a2a.ts:259-269`) after the `isApproved` check:
  read the raw body (it is already in scope as `body`), then:
  - If a signature header is present: `network.verifyPeerSignature(peerId, body, sig)`
    → mismatch ⇒ reject with `-32003` (reuse `ERR_UNAUTHORIZED` style handling)
    and an audit entry `{ event: 'task_rejected', detail: 'bad signature' }`.
  - If absent and `secure` mode is on ⇒ same rejection with detail
    `'signature required'`; otherwise accept (legacy peer) and write an audit
    entry `{ event: 'task_in', detail: 'legacy-peer' }` once per peer per process
    (set a name in a `Set<string>`).

`start()` constructor must receive `secure: boolean` — thread it through
`A2aServerOptions` (`this.opts.config.secure ?? false`).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test -- a2a` → all pass.

### Step 4: Sign outbound calls and announce

- `_handleDelegate` (`src/a2a.ts:353-370`): read the JSON body that will be
  POSTed into a string variable first; if
  `network.getPeer(body.to)?.auth?.secret` exists, add
  `[PEER_SIGNATURE_HEADER]: hmac(secret, bodyString)`.
- `announceToRegistry` (`src/a2a-manager.ts:186-193`) accepts an optional
  `signer?: (body: string) => string | undefined` in options (wired from
  bridge.ts using the registry peer record if one exists); sign when a secret
  is available, omit otherwise (registry-peer semantics are unchanged — plan 002
  covers authorization there).

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass.

### Step 5: Config + docs

- `src/config.ts` `A2aConfig` (around line 58): add `/** Require HMAC peer signatures on inbound A2A requests (0.14 will default this to true). */ secure?: boolean;`
- `acp-connector.example.jsonc`: add commented `secure: true` example under `a2a`.
- README: under the A2A section, a short "Peer authentication" subsection describing the header, the `a2a.secure` flag, and the legacy transition (unsigned peers accepted with audit warnings until `secure`.

**Verify**: `grep -n "secure" src/config.ts acp-connector.example.jsonc` → both mention `a2a.secure`.

## Test plan

In `test/network.test.ts` (pattern: existing NetworkStore unit tests):
- `issues a deterministic secret per peer` — calls `issuePeerAuth` twice,
  expects the same value returned; the secret is hex and present in the saved
  file (assert the *pattern*, never a fixed literal).
- `verifyPeerSignature rejects tampered bodies and foreign peers`.

In `test/a2a-edge.test.ts` (pattern: existing raw HTTP-in-process tests):
- `accepts a signed message/send from a peer with auth`, `accepts an unsigned
  legacy peer when secure is false`, `rejects an unsigned peer when secure is
  true`, `rejects a wrong signature when secure is false`.

Verification: `pnpm test` → all pass, including the new tests.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests listed above exist and pass
- [ ] `grep -rn "x-a2a-peer-signature" src/` finds the header definition and both call sites
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The excerpts in "Current state" no longer match the code.
- `docs/` gained an ADR defining a standardized A2A auth scheme that would
  conflict with per-pairing HMAC.
- An existing test asserts the exact `/a2a/confirm` request body and updating
  it would also weaken a security assertion — report, don't rewrite semantics.
- `network.json` migration would require the schema-version bump (it must not
  here — `auth` is optional).

## Maintenance notes

- Reviewer should scrutinize: timing-safe comparison, secret never logged,
  secret never written to `agent-card` or `peers` API responses.
- Future: when `a2a.secure` defaults to true (0.14 per repo conventions),
  update README + CHANGELOG; the `Set`-based once-per-process legacy warning
  becomes dead after that and should be removed.
- If `/a2a` gains secret rotation, `issuePeerAuth` idempotency must be revisited.
