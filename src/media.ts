import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';

const DEFAULT_UPLOADS_DIR = '/tmp/acp-connector-uploads';

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
      mkdirSync(this.uploadsDir, { recursive: true });
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
    writeFileSync(path, data);
    console.log(`📄 file saved: ${path}`);
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
