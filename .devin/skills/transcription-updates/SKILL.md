---
name: transcription-updates
description: Checklist for evaluating new audio-transcription releases and deciding whether acp-connector needs a new release, plus deployment notes for machines with stale caches.
---

# Transcription dependency upgrades

`acp-connector` consumes [`audio-transcription`](https://www.npmjs.com/package/audio-transcription)
(local sherpa-onnx Parakeet voice-note transcription) via `src/transcriber.ts`.
The engine, model and lifecycle live in that package — this skill covers what
to check when it (or its runtime deps) ships a new version.

## Does acp-connector need a new release?

Decision rule — check in order:

1. **Read the upstream changelog/release notes** (`gh release list -R galiprandi/audio-transcription`, `npm view audio-transcription versions`).
2. **API compatibility**: our seam only uses `transcribeAudio(path, opts)` with
   `cacheDir`, `numThreads`, `lockTimeoutMs`, `onProgress`. If the new version
   keeps that signature, the bridge needs **no code change and no release**.
3. **Semver range**: `package.json` pins `audio-transcription@^0.1.0` — any
   `0.x.y` release resolves automatically on fresh installs (npx cache rebuild,
   `npm install`). Already-installed bridges pick it up on next npx reinstall.
4. **Release IS needed only when**:
   - the public API changed (then update `src/transcriber.ts` + tests + release),
   - we intentionally want to floor the minimum (bump to `^0.2.0` etc.),
   - the bridge code itself changes.

## Points to verify on every upstream release

- [ ] `pnpm test` still green with the new version resolved (`pnpm update audio-transcription` locally, or test against the published tarball)
- [ ] `pnpm typecheck` — `TranscribeOptions`/`TranscribeProgress` shapes unchanged
- [ ] Runtime deps still lazy-installed (no new heavy package `dependencies`)
- [ ] Windows/macOS fixes preserved (`platform.ts`: npm-cli.js, ffmpeg.exe, bsdtar)
- [ ] Model files/URL changes — if the model dir or file names changed,
      confirm our config (`transcription.*`) still maps correctly
- [ ] Real smoke: one voice note through `createTranscriber` → transcript

## Deployed-machine caveats

- **npx cache trap**: bridges run `npx --yes acp-connector` — the package is
  cached in `~/.npm/_npx/<hash>/`. To pick up a new transcriber version,
  remove the cached `node_modules/audio-transcription` (or the whole npx dir)
  and `pm2 restart <bridge>`.
- **Patched caches**: machines where audio-transcription was manually patched
  (e.g. the Windows deployment) keep the patch until the package copy is
  reinstalled — the runtime/model cache (`%LOCALAPPDATA%\audio-transcription`
  or `~/.cache/audio-transcription`) is fine to keep, only the JS package
  needs replacing.
- **Model cache is shared**: all bridges on a machine share
  `~/.cache/audio-transcription` — model/runtime download happens once.

## When upstream ships a new MODEL (not just a version bump)

Model swaps live inside `audio-transcription` (`src/model.ts` there) — the
bridge does not reference model names. Just verify transcription quality on a
real Spanish voice note after upgrading; no bridge release needed unless the
API changed.
