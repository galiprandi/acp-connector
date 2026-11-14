import type { TranscriptionConfig } from './config.js';
import { log } from './logger.js';

/**
 * Voice-note transcription seam. The real implementation delegates to the
 * `audio-transcription` package (sherpa-onnx Parakeet, fully local — the
 * package lazily installs its native runtime + model weights into a shared
 * user cache on first use).
 */
export interface Transcriber {
  /** Transcribe an audio file at `path`; returns plain text. Throws on failure. */
  transcribe(path: string): Promise<string>;
}

export function transcriptionEnabled(config?: TranscriptionConfig): boolean {
  return config?.enabled !== false;
}

export function deleteAfterTranscribe(config?: TranscriptionConfig): boolean {
  return config?.deleteAfterTranscribe !== false;
}

/**
 * Build a Transcriber backed by the audio-transcription package.
 * Returns null when transcription is disabled — callers keep the legacy
 * resource_link path.
 */
export function createTranscriber(config?: TranscriptionConfig): Transcriber | null {
  if (!transcriptionEnabled(config)) return null;
  const opts = {
    cacheDir: config?.cacheDir,
    numThreads: config?.numThreads,
    lockTimeoutMs: config?.lockTimeoutMs,
    onProgress: (e: { stage: string; message: string }) =>
      log.info(`🎙️ [transcription] ${e.stage}: ${e.message}`),
  };
  return {
    async transcribe(path: string): Promise<string> {
      // Dynamic import: the package is only loaded when a voice note actually
      // arrives — bridges that never receive voice pay zero.
      const mod = await import('audio-transcription');
      return mod.transcribeAudio(path, opts);
    },
  };
}
