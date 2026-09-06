import { createServer } from 'node:http';

const DEFAULT_MAX_BODY = 1024 * 1024; // 1MB
const DEFAULT_RATE_LIMIT = 60; // requests per minute

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
  /**
   * @param {Object} opts
   * @param {boolean} [opts.enabled]
   * @param {string} [opts.host] - bind address (default 127.0.0.1)
   * @param {number} [opts.port]
   * @param {string} [opts.authToken] - bearer token for auth
   * @param {boolean} [opts.forwardHeaders] - forward headers to agent (Authorization always stripped)
   * @param {number} [opts.maxBodySize] - max body size in bytes
   * @param {number} [opts.rateLimit] - max requests per minute
   * @param {Function} opts.enqueue - (text, chatId?) => void
   * @param {Function} [opts.getHealth] - () => Object
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
  }) {
    this.enabled = enabled;
    this.host = host;
    this.port = port;
    this.authToken = authToken;
    this.forwardHeaders = forwardHeaders;
    this.maxBodySize = maxBodySize;
    this.rateLimit = rateLimit;
    this.enqueue = enqueue;
    this.getHealth = getHealth || (() => ({ status: 'ok' }));
    this._server = null;
    this._requestTimes = [];
  }

  start() {
    if (!this.enabled) return Promise.resolve();

    this._server = createServer(async (req, res) => {
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

        if (req.method === 'GET' && req.url === '/health') {
          const health = this.getHealth();
          res.writeHead(200);
          res.end(JSON.stringify(health));
          return;
        }

        if (req.method === 'POST' && req.url.startsWith('/prompt')) {
          await this._handlePrompt(req, res);
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return new Promise((resolve) => {
      this._server.listen(this.port, this.host, () => {
        const addr = this._server.address();
        const actualPort = addr?.port || this.port;
        console.log(`🌐 HTTP server on ${this.host}:${actualPort}`);
        resolve();
      });
    });
  }

  async _handlePrompt(req, res) {
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

      // Try to parse as JSON for backward compat (text + chatId fields)
      let promptText = body;
      let chatId;

      try {
        const data = JSON.parse(body);
        if (typeof data.text === 'string') {
          // text field exists — use it (even if empty, will be validated below)
          promptText = data.text;
          chatId = data.chatId;
        }
        // If no text field, use raw body as prompt
      } catch {
        // Not JSON — use raw body as prompt
      }

      if (promptText.trim() === '') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'empty prompt' }));
        return;
      }

      // Build prompt with query params as context
      const url = new URL(req.url, `http://${this.host}:${this.port}`);
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

      this.enqueue(fullPrompt, chatId);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  _checkAuth(req) {
    const auth = req.headers.authorization;
    if (!auth) return false;
    return auth === `Bearer ${this.authToken}`;
  }

  _isRateLimited() {
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

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
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

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}
