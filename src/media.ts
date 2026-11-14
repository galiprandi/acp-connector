import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { log } from './logger.js';
import type { Transcriber } from './transcriber.js';

const DEFAULT_UPLOADS_DIR = '/tmp/acp-connector-uploads';

export interface FetchBufferOpts {
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download a URL into a Buffer with retries.
 *
 * `fetch` failures on messaging-platform CDNs are usually transient
 * (DNS/connection resets), so retry a few times with linear backoff.
 * HTTP 4xx fails fast; 5xx and network errors are retried.
 */
export async function fetchBuffer(url: string, opts: FetchBufferOpts = {}): Promise<Buffer> {
  const retries = opts.retries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    if (res.status < 500 || attempt === retries) throw err;
    await sleep(retryDelayMs * (attempt + 1));
  }
  throw new Error('unreachable');
}

export interface MediaHandlerOpts {
  uploadsDir: string;
  supportsImage: boolean;
  /** Optional voice-note transcriber; when set, voice notes become text. */
  transcriber?: Transcriber | null;
  /** Delete the audio file after transcription (success AND failure). */
  deleteAfterTranscribe?: boolean;
}

export interface DownloadedFile {
  path: string;
  mimeType: string;
  filename: string;
  data: string; // base64
}

/**
 * Media handler: downloads files from messaging platforms,
 * saves them to disk, and converts to ACP ContentBlocks.
 */
export class MediaHandler {
  private uploadsDir: string;
  private supportsImage: boolean;
  private transcriber: Transcriber | null;
  private deleteAfterTranscribe: boolean;

  constructor({
    uploadsDir,
    supportsImage,
    transcriber = null,
    deleteAfterTranscribe = true,
  }: MediaHandlerOpts) {
    this.uploadsDir = uploadsDir || DEFAULT_UPLOADS_DIR;
    this.supportsImage = supportsImage;
    this.transcriber = transcriber;
    this.deleteAfterTranscribe = deleteAfterTranscribe;
    try {
      mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.uploadsDir, 0o700);
      } catch {
        // best-effort: tighten pre-existing dirs; creation mode covers new ones
      }
    } catch {
      // dir may already exist
    }
  }

  /**
   * Save raw buffer data to disk and return file info with base64 data.
   */
  saveFile(data: Buffer, mimeType: string, ext: string): DownloadedFile {
    // `ext` comes from user-controlled file names — restrict it to a safe
    // charset so it can't smuggle path separators or odd filenames into
    // the uploads dir.
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'bin';
    const filename = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const path = join(this.uploadsDir, filename);
    // 'wx' = O_CREAT|O_EXCL: fails instead of following a pre-existing
    // symlink at the target path.
    writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
    log.info(`📄 file saved: ${path}`);
    return { path, mimeType, filename, data: data.toString('base64') };
  }

  /**
   * Convert a downloaded file to ACP ContentBlocks.
   *
   * - Images + agent supports image → ImageContent (base64)
   * - Anything else → ResourceLink (file:// URI)
   */
  toContentBlocks(file: DownloadedFile, caption?: string): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (file.mimeType.startsWith('image/') && this.supportsImage) {
      blocks.push({
        type: 'image',
        data: file.data,
        mimeType: file.mimeType,
        // biome-ignore lint/suspicious/noExplicitAny: ContentBlock union type narrowing
      } as any);
    } else {
      blocks.push({
        type: 'resource_link',
        uri: `file://${file.path}`,
        name: file.filename,
        mimeType: file.mimeType,
        // biome-ignore lint/suspicious/noExplicitAny: ContentBlock union type narrowing
      } as any);
    }

    if (caption) {
      blocks.push({ type: 'text', text: caption } as ContentBlock);
    }

    return blocks;
  }

  /**
   * Download + save + convert in one step.
   * Returns ContentBlocks ready for session.prompt().
   */
  async processMedia(
    downloadFn: () => Promise<Buffer>,
    mimeType: string,
    ext: string,
    caption?: string
  ): Promise<ContentBlock[]> {
    const data = await downloadFn();
    const file = this.saveFile(data, mimeType, ext);
    return this.toContentBlocks(file, caption);
  }

  /** Whether voice notes should go through transcription. */
  get canTranscribe(): boolean {
    return this.transcriber !== null;
  }

  /**
   * Download a voice note, transcribe it, and return a plain text block —
   * indistinguishable from a typed message for the agent. The audio file is
   * deleted afterwards (always on failure; on success per
   * `deleteAfterTranscribe`). Throws on any failure so callers can notify
   * the user; nothing is enqueued in that case.
   */
  async processVoiceNote(
    downloadFn: () => Promise<Buffer>,
    mimeType: string,
    ext: string,
    caption?: string
  ): Promise<ContentBlock[]> {
    if (!this.transcriber) {
      throw new Error('processVoiceNote called without a transcriber');
    }
    const transcriber = this.transcriber;
    const data = await downloadFn();
    const file = this.saveFile(data, mimeType, ext);
    const drop = () => {
      try {
        unlinkSync(file.path);
      } catch {
        /* already gone */
      }
    };
    let transcript: string;
    try {
      transcript = await transcriber.transcribe(file.path);
    } catch (err) {
      drop(); // failure path always deletes the audio
      throw err;
    }
    if (!transcript.trim()) {
      // Empty transcript (silence/noise): failure path — always delete.
      drop();
      throw new Error('Transcription returned empty text');
    }
    if (this.deleteAfterTranscribe) drop();
    const blocks: ContentBlock[] = [{ type: 'text', text: transcript } as ContentBlock];
    if (caption) blocks.push({ type: 'text', text: caption } as ContentBlock);
    log.info(`🎙️ voice note transcribed (${transcript.length} chars)`);
    return blocks;
  }
}
