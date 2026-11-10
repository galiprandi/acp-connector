import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { log } from './logger.js';

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

  constructor({ uploadsDir, supportsImage }: MediaHandlerOpts) {
    this.uploadsDir = uploadsDir || DEFAULT_UPLOADS_DIR;
    this.supportsImage = supportsImage;
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
    const filename = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const path = join(this.uploadsDir, filename);
    writeFileSync(path, data, { mode: 0o600 });
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
}
