# Plan 006: Voice note transcription (Telegram + Discord) via sherpa-onnx Parakeet TDT v3

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (this plan is outside the security-remediation set —
> append a new section if the table format doesn't fit).
>
> **Drift check (run first)**:
> `git diff --stat f66f3a6..HEAD -- src/media.ts src/bot.ts src/discord.ts src/base-bot.ts src/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (feature)
- **Effort**: L
- **Risk**: MED (runtime npm install + native module + large model download; mitigated by lazy-on-first-audio and hard fallbacks)
- **Depends on**: none
- **Category**: feature
- **Planned at**: commit `f66f3a6`, 2026-11-14
- **Operator decisions** (from spec interview): transcription ON by default,
  audio deleted after transcription by default, both configurable; only voice
  notes (not audio file attachments); on failure notify user and delete the
  audio anyway; no duration limit; model + runtime shared per-machine across
  all acp-connector instances via a user-level cache dir.

## Why this matters

Voice notes are the dominant way users talk to their agents on Telegram, but
today they arrive as `resource_link` blocks — the agent must spend context
deciding to transcribe, and the audio file accumulates on disk forever.
Transcribing at the bridge layer delivers plain text to the agent
(indistinguishable from typed text) and lets us delete the audio.

## Current state

- `src/media.ts` — `MediaHandler.processMedia(downloadFn, mimeType, ext, caption)`
  downloads → `saveFile` → `toContentBlocks`. Non-image files become
  `{type:'resource_link', uri: file://...}`.
- `src/bot.ts:221` — media detection includes `msg.voice`; `:277-279` maps
  `msg.voice` → `file_id`, `mime_type || 'audio/ogg'`; `:298` calls
  `processMedia`.
- `src/discord.ts:203-257` — attachments loop calls `processMedia` per
  attachment with `attachment.contentType` and `attachment.url`.
  discord.js exposes voice messages via `MessageFlags.IsVoiceMessage`
  (verified in `node_modules/discord.js/typings/index.d.ts:7239`) and they
  arrive as audio/ogg attachments.
- `src/base-bot.ts:178-192` (bot.ts impl) — queued prompts get a 😴 reaction
  via `setMessageReaction`, cleared on dequeue (`:668-669`). Discord has an
  equivalent reaction path. Reuse this pattern for a "transcribing" reaction.
- `src/config.ts` — JSONC config loader; `media.uploadsDir` already exists
  (`acp-connector.example.jsonc:112-114`).

## Design

### Config (all under a new top-level `transcription` key)

```jsonc
"transcription": {
  "enabled": true,               // default: true — voice notes are transcribed
  "deleteAfterTranscribe": true, // default: true — delete audio file after processing (success AND failure)
  "cacheDir": null               // default: XDG-aware user cache (see below); shared by all instances on this machine/user
}
```

- `enabled: false` → today's behavior exactly (voice notes → resource_link).
- `deleteAfterTranscribe: false` → keep the file in `uploadsDir` after
  successful transcription (failure path still deletes per operator decision —
  see Failure handling).
- `cacheDir` override for shared/network paths. Default resolution order:
  `transcription.cacheDir` → `XDG_CACHE_HOME/acp-connector` →
  `~/.cache/acp-connector` (Windows: `%LOCALAPPDATA%/acp-connector`).
  Inside it: `runtime/` (npm-installed node modules) and
  `models/parakeet-tdt-0.6b-v3/` (weights).

### New module: `src/transcription/`

Keep `media.ts` thin; transcription is a separate concern. Suggested layout:

```
src/transcription/
├── index.ts        — public API: transcribeAudioFile(path|buffer): Promise<string>
├── runtime.ts      — lazy npm install of sherpa-onnx-node + ffmpeg-static into cacheDir/runtime
├── model.ts        — lazy download/extract of parakeet ONNX bundle into cacheDir/models
├── decoder.ts      — ogg/ogg-opus → 16kHz mono WAV via ffmpeg-static → Float32Array
└── recognizer.ts   — sherpa-onnx-node OfflineRecognizer singleton
```

#### Runtime install (first audio only)

- Trigger: first time a voice note needs transcription AND `enabled`.
  Nothing is installed at `npm install acp-connector` time and nothing at
  startup — an instance that never receives voice pays zero.
- Command: `npm install --prefix <cacheDir>/runtime sherpa-onnx-node@<pinned> ffmpeg-static@<pinned>`
  - Pin exact versions at implementation time; record them in this plan's
    completion notes and CHANGELOG. As of planning: `sherpa-onnx-node@2.0.1`
    (optionalDeps ship prebuilt binaries for linux/darwin/windows ×
    x64/arm64 — covers all 3 target OSes).
  - `ffmpeg-static` ships per-platform ffmpeg binaries; needed because
    sherpa-onnx accepts WAV, not ogg/opus.
- Concurrency: multiple acp-connector instances may hit this simultaneously.
  Guard with a lock dir (`runtime/.installing` via `mkdir`, atomic) — the
  loser waits/polls for the winner's marker file, then proceeds.
- Load via `createRequire(pathTo(runtime/node_modules))` — sherpa-onnx-node
  is CommonJS; the connector is ESM.
- Failure → treat as transcription failure (see below). Log the npm stderr.

#### Model download (first transcription only)

- Artifact: `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` from
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`
  (~490MB compressed). Contents: `encoder-*.onnx`, `decoder-*.onnx`,
  `joiner-*.onnx`, `tokens.txt` (executor: verify exact filenames inside the
  tarball before wiring paths).
- Download to `models/parakeet-tdt-0.6b-v3/.tmp/`, extract with system `tar`
  (`tar -xf` — present on Linux/macOS and Windows ≥10 as bsdtar), then write
  a `.complete` marker and rename into place. Same lock-dir pattern as the
  runtime install.
- ONNX weights are platform-agnostic — one cache serves all OSes for a given
  user/machine. Different users/machines each download once (by design).

#### Recognition

- `featConfig`: `{ sampleRate: 16000, featureDim: 80 }` (verify against
  sherpa-onnx parakeet v3 docs — NeMo fast-conformer uses 80-dim fbank).
- `modelConfig.transducer`: `{ encoder, decoder, joiner }` absolute paths;
  `modelConfig.tokens`: path to `tokens.txt`; `numThreads`: leave default or
  expose later (not in this plan).
- Decode: ffmpeg-static → `ffmpeg -i <in> -ac 1 -ar 16000 -f wav <out.wav>`
  (or f32le PCM pipe — executor's choice, WAV + `readWave` is simplest since
  sherpa-onnx-node exports it).
- Recognize: `OfflineRecognizer.createAsync(config)` once, reuse the
  singleton; per audio: `createStream()` → `acceptWaveform({samples,
  sampleRate:16000})` → `decodeAsync(stream)` → `result.text`.
- sherpa-onnx-node is CJS with native bindings — all imports must go through
  the lazily-created `createRequire`; never top-level import it, or installs
  without voice notes would still need the binary.

### Telegram integration (`src/bot.ts`)

- In the media branch (`msg.voice` path, ~line 277): when
  `transcription.enabled`, download the file as today, then:
  1. Add 🎧 reaction to the user's message (new `_addTranscribingReaction` /
     `_clearTranscribingReaction` pair mirroring the 😴 queued-reaction
     methods; clear in all exit paths).
  2. `await transcribeAudioFile(path)` → transcript text.
  3. Build ContentBlocks as `{type:'text', text: <transcript>}` — NO
     resource_link, NO mention that it was audio. Caption, if present, is
     appended as a second text block (same as today).
  4. Enqueue the prompt exactly like a typed message.
- `msg.audio` (audio file attachments) and all other media: unchanged —
  still resource_link. ONLY `msg.voice` transcribes.
- The transcription happens BEFORE `enqueuePrompt`, so it serializes with the
  prompt queue for free (queue stays one-at-a-time; a long audio delays
  subsequent prompts — acceptable, documented).

### Discord integration (`src/discord.ts`)

- In the attachments loop (~line 240): an attachment is a voice message iff
  `msg.flags.has(MessageFlags.IsVoiceMessage)` (verify exact API at
  implementation — flag may also be checkable via `attachment.contentType ===
  'audio/ogg'` + flag; prefer the flag). Only then route through
  transcription; regular audio/file attachments unchanged.
- Reactions: discord.js `msg.react('🎧')` / `msg.reactions` removal — mirror
  whatever the queued-indicator does on Discord (check
  `_addQueuedReaction`/`_clearQueuedReaction` impls in discord.ts/base-bot;
  if Discord has no queued reaction today, a best-effort `msg.react` that
  swallows errors is fine).

### Failure handling (operator-decided)

Any failure in download-decode-install-transcribe →
1. Clear the 🎧 reaction.
2. Send the user a short English message (repo rule: user-facing bot messages
   in English), e.g. `🎙️ Transcription failed — please resend the voice note.`
   Include the error summary for operability.
3. Delete the audio file regardless of `deleteAfterTranscribe`
   (operator decision: "avisar + borrar siempre").
4. Do NOT enqueue anything; do NOT fall back to resource_link.
Log full error with `log.error`.

### Deletion

- After successful transcription: delete the saved file iff
  `deleteAfterTranscribe` (default true). Delete = `unlink` the file in
  `uploadsDir` (or temp path if we skip saving — executor may choose to
  transcribe from a temp file outside uploadsDir when deletion is certain;
  simplest correct path: save → transcribe → conditional delete).
- On failure: always delete (see above).
- Never delete on `enabled:false` or non-voice media — unchanged behavior.

## Files to modify / create

- `src/transcription/*` — new module (above)
- `src/media.ts` — likely unchanged; transcription intercepts BEFORE
  `processMedia` in the bots, or add an optional `transcriber` hook to
  MediaHandler — executor picks the cleaner seam, but the voice-note path
  must not regress other media types.
- `src/bot.ts` — voice branch + reaction methods
- `src/discord.ts` — voice-message attachment branch
- `src/base-bot.ts` — only if a shared reaction abstraction is cleaner;
  otherwise platform-local methods like today's queued reaction
- `src/config.ts` — parse/validate `transcription` block (zod or manual per
  existing style)
- `acp-connector.example.jsonc` — document the new block (commented, with
  defaults explained)
- `README.md` — short feature section (repo rule: every feature updates docs)
- `AGENTS.md` — add `src/transcription/` to the architecture tree if the
  module lands as a directory
- `CHANGELOG.md` — under Unreleased

## Tests (all in English per repo rules)

- Unit: config parsing defaults (`enabled`/`deleteAfterTranscribe` default
  true; `cacheDir` resolution order).
- Unit: transcription module with mocked runtime/model/recognizer —
  success path returns text; failure path throws typed error.
- Unit: bot-level — voice note + transcription enabled → prompt enqueued
  with text block, no resource_link, file deleted; `enabled:false` →
  resource_link path unchanged; transcription throws → error message sent,
  file deleted, nothing enqueued.
- Discord: voice-message-flagged attachment transcribes; normal attachment
  unchanged.
- Cache/lock logic: second concurrent caller waits for `.complete` marker.
- Do NOT hit network or native modules in tests — inject fakes.
- `pnpm behavior` regenerates BEHAVIOR.md (pre-commit does it automatically).

## Verification

- `pnpm test && pnpm lint && pnpm typecheck` — all green.
- Manual smoke (executor, if environment allows): send a real Telegram voice
  note to a test bot; verify text reaches agent, file deleted, 🎧 reaction
  appears/clears. First run downloads ~730MB — expect minutes.

## STOP conditions

- sherpa-onnx-node has no prebuilt binary for a required platform at the
  pinned version → STOP, report (do not fall back to Python/transformers.js
  silently — that's a design change).
- Parakeet v3 int8 artifact filename/structure differs from documented →
  verify and adapt paths, but STOP if the model itself changed.
- Discord `IsVoiceMessage` flag proves unusable in practice (e.g. voice
  messages don't arrive as attachments) → implement Telegram-only, document
  the limitation, and report.
- Anything requiring Python, GPU, or HF tokens → STOP (out of scope by design).

## Open risks / notes for executor

- First transcription on a fresh machine downloads ~730MB and runs npm —
  expect minutes; the 🎧 reaction covers the UX. Subsequent runs are fast.
- `decodeAsync` exists on the recognizer — prefer it so the event loop stays
  responsive during long audios (it still burns CPU; numThreads tuning is a
  follow-up, not this plan).
- sherpa-onnx-node native addon must load under the Node version used by
  `npx acp-connector` (engines: node >=20 — fine).
- If `npm` is unavailable in the runtime environment, runtime install fails →
  failure path (notify + delete). Acceptable: anyone running via `npx` has npm.
- Language: parakeet v3 auto-detects among 25 European languages incl.
  Spanish — no language config needed.
