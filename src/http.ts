import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { ContentBlock } from '@agentclientprotocol/sdk';

const DEFAULT_MAX_BODY = 1024 * 1024; // 1MB
const DEFAULT_RATE_LIMIT = 60; // requests per minute

/**
 * Health object returned by the `getHealth` callback.
 */
export interface HealthStatus {
  status: string;
  [key: string]: unknown;
}

/**
 * Callback invoked when the agent finishes processing a prompt.
 * @param response - The agent's final response text (empty if error).
 * @param error - Error message if the prompt failed, undefined otherwise.
 */
export type OnCompleteFn = (response: string, error?: string) => void;

/**
 * Enqueue callback signature: `(text, chatId?, blocks?, onComplete?) => void`.
 */
export type EnqueueFn = (
  text: string,
  chatId?: number,
  blocks?: ContentBlock[],
  onComplete?: OnCompleteFn
) => void;

/**
 * Health callback signature: `() => HealthStatus`.
 */
export type GetHealthFn = () => HealthStatus;

/**
 * Options for constructing an {@link HttpServer}.
 */
export interface HttpServerOptions {
  /** Whether the server is enabled. */
  enabled?: boolean;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** Port to listen on. */
  port?: number;
  /** Bearer token for auth. */
  authToken?: string | null;
  /** Forward headers to agent (Authorization always stripped). */
  forwardHeaders?: boolean;
  /** Max body size in bytes. */
  maxBodySize?: number;
  /** Max requests per minute. */
  rateLimit?: number;
  /** `(text, chatId?) => void` — enqueue a prompt. */
  enqueue: EnqueueFn;
  /** `() => HealthStatus` — provide health info. */
  getHealth?: GetHealthFn | null;
}

/**
 * Optional HTTP server for external prompt injection and health checks.
 *
 * Security:
 * - Defaults to 127.0.0.1 (localhost only)
 * - Optional bearer token auth
 * - Authorization header is never forwarded to the agent
 * - Body size limit (default 1MB)
 * - Rate limit (default 60 req/min)
 */
export class HttpServer {
  enabled: boolean;
  host: string;
  port: number;
  authToken: string | null;
  forwardHeaders: boolean;
  maxBodySize: number;
  rateLimit: number;
  enqueue: EnqueueFn;
  getHealth: GetHealthFn;
  private _server: Server | null = null;
  private _requestTimes: number[] = [];

  /**
   * @param opts Constructor options. See {@link HttpServerOptions}.
   */
  constructor({
    enabled = false,
    host = '127.0.0.1',
    port = 7780,
    authToken = null,
    forwardHeaders = false,
    maxBodySize = DEFAULT_MAX_BODY,
    rateLimit = DEFAULT_RATE_LIMIT,
    enqueue,
    getHealth = null,
  }: HttpServerOptions) {
    this.enabled = enabled;
    this.host = host;
    this.port = port;
    this.authToken = authToken;
    this.forwardHeaders = forwardHeaders;
    this.maxBodySize = maxBodySize;
    this.rateLimit = rateLimit;
    this.enqueue = enqueue;
    this.getHealth = getHealth || (() => ({ status: 'ok' }));
  }

  start(): Promise<void> {
    if (!this.enabled) return Promise.resolve();

    this._server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');

      try {
        // Rate limit check
        if (this._isRateLimited()) {
          res.writeHead(429);
          res.end(JSON.stringify({ error: 'rate limit exceeded' }));
          return;
        }

        // Auth check
        if (this.authToken && !this._checkAuth(req)) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        const parsedUrl = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);

        if (req.method === 'GET' && parsedUrl.pathname === '/health') {
          const health = this.getHealth();
          res.writeHead(200);
          res.end(JSON.stringify(health));
          return;
        }

        if (req.method === 'POST' && parsedUrl.pathname === '/prompt') {
          await this._handlePrompt(req, res, parsedUrl);
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });

    return new Promise<void>((resolve) => {
      this._server?.listen(this.port, this.host, () => {
        const addr = this._server?.address();
        const actualPort =
          (addr && typeof addr === 'object' && 'port' in addr ? addr.port : null) ?? this.port;
        console.log(`🌐 HTTP server on ${this.host}:${actualPort}`);
        resolve();
      });
    });
  }

  async _handlePrompt(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      // Check Content-Length before reading
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > this.maxBodySize) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'body too large' }));
        return;
      }

      const body = await this._readBody(req);
      if (body.trim() === '') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'empty request body' }));
        return;
      }

      // Try to parse as JSON for backward compat (text + chatId + files fields)
      let promptText = body;
      let chatId: number | undefined;
      let blocks: ContentBlock[] | undefined;
      let callbackUrl: string | undefined;

      try {
        const data = JSON.parse(body) as {
          text?: string;
          chatId?: number | string;
          callbackUrl?: string;
          callback_url?: string;
          files?: Array<{ data: string; mimeType: string; filename?: string }>;
        };
        if (typeof data.text === 'string') {
          promptText = data.text;
          chatId = typeof data.chatId === 'number' ? data.chatId : undefined;
          callbackUrl = data.callbackUrl || data.callback_url;

          // Build ContentBlocks from files
          if (data.files && Array.isArray(data.files) && data.files.length > 0) {
            const fileBlocks: ContentBlock[] = [];
            for (const file of data.files) {
              if (!file.data || !file.mimeType) continue;
              if (file.mimeType.startsWith('image/')) {
                fileBlocks.push({
                  type: 'image',
                  data: file.data,
                  mimeType: file.mimeType,
                  // biome-ignore lint/suspicious/noExplicitAny: ContentBlock union type narrowing
                } as any);
              } else {
                fileBlocks.push({
                  type: 'resource_link',
                  uri: `data:${file.mimeType};base64,${file.data}`,
                  name: file.filename || 'file',
                  mimeType: file.mimeType,
                  // biome-ignore lint/suspicious/noExplicitAny: ContentBlock union type narrowing
                } as any);
              }
            }
            if (fileBlocks.length > 0) {
              blocks = fileBlocks;
              // Add text as last block
              if (promptText.trim()) {
                blocks.push({ type: 'text', text: promptText } as ContentBlock);
              }
            }
          }
        }
      } catch {
        // Not JSON — use raw body as prompt
      }

      if (promptText.trim() === '' && (!blocks || blocks.length === 0)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'empty prompt' }));
        return;
      }

      // Build prompt with query params as context
      const params = url.searchParams;
      const paramEntries = [...params.entries()];

      let fullPrompt = promptText;
      if (paramEntries.length > 0) {
        const context = paramEntries.map(([k, v]) => `${k}=${v}`).join(', ');
        fullPrompt = `[${context}] ${promptText}`;
      }

      // Forward headers if enabled (Authorization always stripped)
      if (this.forwardHeaders) {
        const headers = { ...req.headers };
        delete headers.authorization;
        delete headers['content-length'];
        delete headers['content-type'];
        delete headers.host;
        const headerStr = JSON.stringify(headers);
        if (headerStr !== '{}') {
          fullPrompt = `${fullPrompt}\nheaders: ${headerStr}`;
        }
      }

      // Build onComplete callback if callbackUrl provided
      let onComplete: OnCompleteFn | undefined;
      if (callbackUrl) {
        onComplete = (response: string, error?: string) => {
          fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response, error: error || null }),
          }).catch((err: unknown) => {
            console.error(`Webhook callback failed: ${(err as Error).message}`);
          });
        };
      }

      this.enqueue(fullPrompt, chatId, blocks, onComplete);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  _checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth) return false;
    return auth === `Bearer ${this.authToken}`;
  }

  _isRateLimited(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean old entries
    this._requestTimes = this._requestTimes.filter((t) => t > oneMinuteAgo);

    if (this._requestTimes.length >= this.rateLimit) {
      return true;
    }

    this._requestTimes.push(now);
    return false;
  }

  _readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodySize) {
          tooLarge = true;
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        if (!tooLarge) resolve(data);
      });
      req.on('error', reject);
    });
  }

  stop(): void {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}
