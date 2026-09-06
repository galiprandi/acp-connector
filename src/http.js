import { createServer } from 'node:http';

/**
 * Optional HTTP server for external prompt injection and health checks.
 */
export class HttpServer {
  /**
   * @param {Object} opts
   * @param {boolean} [opts.enabled]
   * @param {number} [opts.port]
   * @param {Function} opts.enqueue - (text, chatId?) => void
   * @param {Function} [opts.getHealth] - () => Object
   */
  constructor({ enabled = false, port = 7780, enqueue, getHealth = null }) {
    this.enabled = enabled;
    this.port = port;
    this.enqueue = enqueue;
    this.getHealth = getHealth || (() => ({ status: 'ok' }));
    this._server = null;
  }

  start() {
    if (!this.enabled) return;

    this._server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url === '/health') {
        const health = this.getHealth();
        res.writeHead(200);
        res.end(JSON.stringify(health));
        return;
      }

      if (req.method === 'POST' && req.url === '/prompt') {
        try {
          const body = await this._readBody(req);
          if (body.trim() === '') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'empty request body' }));
            return;
          }
          const data = JSON.parse(body);
          if (typeof data.text !== 'string' || data.text.trim() === '') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'text is required' }));
            return;
          }
          this.enqueue(data.text, data.chatId);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });

    this._server.listen(this.port);
    console.log(`🌐 HTTP server on port ${this.port}`);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => resolve(data));
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
