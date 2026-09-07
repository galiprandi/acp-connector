import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EnqueueFn,
  GetHealthFn,
  HttpServerOptions,
  HttpServer as HttpServerType,
} from '../src/http';

const { HttpServer } = await import('../src/http.ts');

type TestableHttpServer = HttpServerType & {
  _server: Server | null;
  _requestTimes: number[];
};

function createServer(overrides: Partial<HttpServerOptions> = {}) {
  const enqueue = vi.fn();
  const getHealth = vi.fn(() => ({ status: 'ok', agent: true, session: 'test-session' }));
  const server = new HttpServer({
    enabled: true,
    port: 0,
    enqueue: enqueue as unknown as EnqueueFn,
    getHealth: getHealth as unknown as GetHealthFn,
    ...overrides,
  });
  return { server: server as unknown as TestableHttpServer, enqueue, getHealth };
}

async function fetchServer(
  server: TestableHttpServer,
  method: string,
  path: string,
  body: string | Record<string, unknown> | null = null,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; raw: string; headers: Headers }> {
  const port = server._server?.address()?.port;
  if (!port) throw new Error('server not started');
  const url = `http://localhost:${port}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, raw: text, headers: res.headers };
}

describe('HttpServer security tests', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  // Auth bypass attempts

  it('rejects lowercase bearer scheme', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: 'bearer my-secret',
      }
    );
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects Basic auth scheme even with correct token', async () => {
    const { server } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: 'Basic my-secret',
      }
    );
    expect(res.status).toBe(401);
  });

  it('rejects empty bearer token', async () => {
    const { server } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: 'Bearer ',
      }
    );
    expect(res.status).toBe(401);
  });

  it('rejects token with extra spaces', async () => {
    const { server } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: 'Bearer  my-secret',
      }
    );
    expect(res.status).toBe(401);
  });

  it('accepts token with special characters', async () => {
    const token = 'my-secret!@#$%^&*()_+-=';
    const { server, enqueue } = createServer({ authToken: token });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: `Bearer ${token}`,
      }
    );
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects very long token (DoS attempt)', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const longToken = 'x'.repeat(100000);
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: `Bearer ${longToken}`,
      }
    );
    // Node may reject with 431 (header too large) or our code with 401
    expect([401, 431]).toContain(res.status);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Path traversal

  it('rejects path traversal in URL', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt/../../../etc/passwd');
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('handles URL-encoded query params', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt?from=boss%40company.com', {
      text: 'hi',
    });
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toContain('boss@company.com');
  });

  it('handles empty query param values', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt?origin=&from=boss', {
      text: 'hi',
    });
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toContain('origin=');
    expect(enqueue.mock.calls[0][0]).toContain('from=boss');
  });

  it('handles many query params', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const params = 'a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10';
    const res = await fetchServer(server, 'POST', `/prompt?${params}`, { text: 'hi' });
    expect(res.status).toBe(200);
    const prompt = enqueue.mock.calls[0][0];
    expect(prompt).toContain('a=1');
    expect(prompt).toContain('j=10');
  });

  // Body edge cases

  it('handles body with unicode', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hola 🇦🇷 café naïve' });
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toContain('🇦🇷');
  });

  it('handles JSON array body as raw prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', '[1, 2, 3]');
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toBe('[1, 2, 3]');
  });

  it('handles JSON string body as raw prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', '"just a string"');
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toBe('"just a string"');
  });

  it('handles JSON number body as raw prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', '42');
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toBe('42');
  });

  it('handles JSON null body as raw prompt', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', 'null');
    // null is valid JSON but trim() is "null" which is not empty
    expect(res.status).toBe(200);
  });

  it('handles body with newlines', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'line1\nline2\nline3' });
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toContain('line1\nline2');
  });

  // Rate limit edge cases

  it('rate limit counts all requests including /health', async () => {
    const { server } = createServer({ rateLimit: 3 });
    await server.start();
    cleanup.push(() => server.stop());
    // 2 health checks + 1 prompt = 3 requests
    await fetchServer(server, 'GET', '/health');
    await fetchServer(server, 'GET', '/health');
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hi' });
    expect(res.status).toBe(200);
    // 4th request should be rate limited
    const res2 = await fetchServer(server, 'GET', '/health');
    expect(res2.status).toBe(429);
  });

  it('rate limit resets after entries expire', async () => {
    const { server } = createServer({ rateLimit: 2 });
    await server.start();
    cleanup.push(() => server.stop());
    // Use 2 requests
    await fetchServer(server, 'POST', '/prompt', { text: 'msg1' });
    await fetchServer(server, 'POST', '/prompt', { text: 'msg2' });
    // 3rd should fail
    const blocked = await fetchServer(server, 'POST', '/prompt', { text: 'msg3' });
    expect(blocked.status).toBe(429);
    // Manually expire entries (simulates time passing)
    server._requestTimes = [];
    // Should work again
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'msg4' });
    expect(res.status).toBe(200);
  });

  it('rate limit with auth still counts unauthorized requests', async () => {
    const { server, enqueue } = createServer({ rateLimit: 2, authToken: 'secret' });
    await server.start();
    cleanup.push(() => server.stop());
    // 2 unauthorized requests
    await fetchServer(server, 'POST', '/prompt', { text: 'hi' });
    await fetchServer(server, 'POST', '/prompt', { text: 'hi' });
    // 3rd request — even with correct auth — should be rate limited
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hi' },
      {
        Authorization: 'Bearer secret',
      }
    );
    expect(res.status).toBe(429);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Integration: combined features

  it('auth + query params + forward headers all work together', async () => {
    const { server, enqueue } = createServer({
      authToken: 'my-secret',
      forwardHeaders: true,
    });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt?origin=outlook&priority=high',
      { text: 'urgent email' },
      {
        Authorization: 'Bearer my-secret',
        'X-Webhook-Id': 'wh-123',
        'X-Custom': 'val',
      }
    );
    expect(res.status).toBe(200);
    const prompt = enqueue.mock.calls[0][0];
    // Query params in context
    expect(prompt).toContain('origin=outlook');
    expect(prompt).toContain('priority=high');
    // Body text
    expect(prompt).toContain('urgent email');
    // Custom headers forwarded
    expect(prompt).toContain('x-webhook-id');
    expect(prompt).toContain('wh-123');
    // Authorization NOT forwarded
    expect(prompt).not.toContain('my-secret');
    expect(prompt).not.toContain('Bearer');
  });

  it('raw body + query params + auth all work together', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const rawPayload = JSON.stringify({
      from: 'boss@company.com',
      subject: 'URGENT',
      body: 'need report ASAP',
    });
    const res = await fetchServer(server, 'POST', '/prompt?source=outlook&type=email', rawPayload, {
      Authorization: 'Bearer my-secret',
    });
    expect(res.status).toBe(200);
    const prompt = enqueue.mock.calls[0][0];
    expect(prompt).toContain('source=outlook');
    expect(prompt).toContain('type=email');
    expect(prompt).toContain('boss@company.com');
    expect(prompt).toContain('URGENT');
  });

  // Content-Type edge cases

  it('handles text/plain content type', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const port = server._server?.address()?.port;
    const res = await fetch(`http://localhost:${port}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain text message',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(enqueue.mock.calls[0][0]).toBe('plain text message');
  });

  it('handles no content type', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const port = server._server?.address()?.port;
    const res = await fetch(`http://localhost:${port}/prompt`, {
      method: 'POST',
      body: 'no content type body',
    });
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toBe('no content type body');
  });

  // HTTP method edge cases

  it('GET /prompt returns 404 (not 405)', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/prompt');
    expect(res.status).toBe(404);
  });

  it('PUT /prompt returns 404', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const port = server._server?.address()?.port;
    const res = await fetch(`http://localhost:${port}/prompt`, {
      method: 'PUT',
      body: '{"text":"hi"}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /prompt returns 404', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const port = server._server?.address()?.port;
    const res = await fetch(`http://localhost:${port}/prompt`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // /prompt with subpath

  it('POST /prompt/extra returns 404', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt/extra', { text: 'hi' });
    expect(res.status).toBe(404);
  });

  // /health with auth

  it('GET /health with correct auth returns 200', async () => {
    const { server } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/health', null, {
      Authorization: 'Bearer my-secret',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // Response format

  it('all responses are JSON', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('error responses include error field', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
