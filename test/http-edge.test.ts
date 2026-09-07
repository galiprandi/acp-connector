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
    port: 0, // ephemeral port
    enqueue: enqueue as unknown as EnqueueFn,
    getHealth: getHealth as unknown as GetHealthFn,
    ...overrides,
  });
  return { server: server as unknown as TestableHttpServer, enqueue, getHealth };
}

/**
 * Fetch helper that supports raw (non-JSON) bodies for edge-case testing.
 * @param server - The HttpServer instance to test
 * @param method - HTTP method
 * @param path - Request path
 * @param body - string = raw body, object = JSON, null = no body
 * @param headers - Additional headers
 */
async function fetchServer(
  server: TestableHttpServer,
  method: string,
  path: string,
  body: string | Record<string, unknown> | null = null,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; raw: string }> {
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
  return { status: res.status, body: parsed, raw: text };
}

describe('HttpServer edge cases', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  it('POST /prompt with no body returns 400', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', null);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with invalid JSON uses raw body as prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', 'plain text not json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('plain text not json', undefined, undefined, undefined);
  });

  it('POST /prompt with empty text returns 400', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: '' });
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with whitespace-only text returns 400', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: '   ' });
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with text but no chatId enqueues with undefined', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', undefined, undefined, undefined);
  });

  it('GET /unknown route returns 404', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });

  it('POST /unknown route returns 404', async () => {
    const { server } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/unknown', { foo: 'bar' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });

  it('double stop() is idempotent and does not throw', async () => {
    const { server } = createServer();
    await server.start();
    expect(() => {
      server.stop();
      server.stop();
    }).not.toThrow();
    expect(server._server).toBeNull();
  });

  it('health check with no agent session (default getHealth) returns 200 ok', async () => {
    const { server } = createServer({ getHealth: null });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('health check with agent session returns session info', async () => {
    const getHealth = vi.fn(() => ({
      status: 'ok',
      agent: true,
      session: 'sess-abc',
      uptime: 123,
    }));
    const { server } = createServer({ getHealth: getHealth as unknown as GetHealthFn });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', agent: true, session: 'sess-abc', uptime: 123 });
    expect(getHealth).toHaveBeenCalledOnce();
  });

  it('server does not start when enabled=false', () => {
    const { server } = createServer({ enabled: false });
    server.start();
    expect(server._server).toBeNull();
    expect(() => server.stop()).not.toThrow();
  });

  it('POST /prompt with large body (>10KB) is accepted', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const big = 'x'.repeat(11 * 1024);
    const res = await fetchServer(server, 'POST', '/prompt', { text: big });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toHaveLength(11 * 1024);
  });

  it('POST /prompt with extra fields ignores them and enqueues text', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      chatId: 42,
      extra: 'ignored',
      nested: { a: 1 },
      bogus: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', 42, undefined, undefined);
  });

  it('POST /prompt with non-string text uses raw body as prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 123 });
    // text is not a string, so raw body is used as prompt
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('GET /health does not call enqueue', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'GET', '/health');
    expect(enqueue).not.toHaveBeenCalled();
  });

  // New feature tests: query params as context

  it('POST /prompt with query params adds context to prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt?origin=outlook&from=boss', {
      text: 'urgent email',
    });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toBe('[origin=outlook, from=boss] urgent email');
  });

  it('POST /prompt without query params sends text as-is', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello' });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith('hello', undefined, undefined, undefined);
  });

  it('POST /prompt with raw body + query params adds context', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt?source=github&action=push',
      '{"repo":"acp-connector"}'
    );
    expect(res.status).toBe(200);
    expect(enqueue.mock.calls[0][0]).toBe('[source=github, action=push] {"repo":"acp-connector"}');
  });

  // Auth tests

  it('POST /prompt without auth token when configured returns 401', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello' });
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with wrong bearer token returns 401', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hello' },
      {
        Authorization: 'Bearer wrong-token',
      }
    );
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with correct bearer token enqueues', async () => {
    const { server, enqueue } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hello' },
      {
        Authorization: 'Bearer my-secret',
      }
    );
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith('hello', undefined, undefined, undefined);
  });

  it('GET /health with auth token configured requires auth', async () => {
    const { server } = createServer({ authToken: 'my-secret' });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.status).toBe(401);
  });

  it('Authorization header is never forwarded to agent', async () => {
    const { server, enqueue } = createServer({
      authToken: 'my-secret',
      forwardHeaders: true,
    });
    await server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(
      server,
      'POST',
      '/prompt',
      { text: 'hello' },
      {
        Authorization: 'Bearer my-secret',
        'X-Custom': 'custom-value',
      }
    );
    expect(res.status).toBe(200);
    const prompt = enqueue.mock.calls[0][0];
    expect(prompt).not.toContain('my-secret');
    expect(prompt).not.toContain('Bearer');
    expect(prompt).toContain('custom-value');
  });

  // Rate limit tests

  it('rate limit returns 429 after exceeding limit', async () => {
    const { server } = createServer({ rateLimit: 3 });
    await server.start();
    cleanup.push(() => server.stop());
    // Send 3 requests (should pass)
    for (let i = 0; i < 3; i++) {
      const res = await fetchServer(server, 'POST', '/prompt', { text: `msg${i}` });
      expect(res.status).toBe(200);
    }
    // 4th request should be rate limited
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'msg4' });
    expect(res.status).toBe(429);
  });

  // Body size limit tests

  it('body exceeding maxBodySize returns 413', async () => {
    const { server, enqueue } = createServer({ maxBodySize: 100 });
    await server.start();
    cleanup.push(() => server.stop());
    const big = 'x'.repeat(200);
    const res = await fetchServer(server, 'POST', '/prompt', { text: big });
    expect(res.status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Forward headers tests

  it('forwardHeaders disabled by default', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', { text: 'hello' }, { 'X-Custom': 'custom-value' });
    const prompt = enqueue.mock.calls[0][0];
    expect(prompt).not.toContain('X-Custom');
    expect(prompt).not.toContain('headers');
  });

  it('forwardHeaders enabled includes custom headers in prompt', async () => {
    const { server, enqueue } = createServer({ forwardHeaders: true });
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', { text: 'hello' }, { 'X-Custom': 'custom-value' });
    const prompt = enqueue.mock.calls[0][0];
    expect(prompt).toContain('x-custom');
    expect(prompt).toContain('custom-value');
  });

  it('POST /prompt with image file passes ContentBlocks', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'analiza esta imagen',
      files: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png', filename: 'screenshot.png' }],
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, , blocks] = enqueue.mock.calls[0];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].data).toBe('iVBORw0KGgo=');
    expect(blocks[0].mimeType).toBe('image/png');
    // Text appended as last block
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toBe('analiza esta imagen');
  });

  it('POST /prompt with non-image file creates resource_link', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'lee este PDF',
      files: [{ data: 'JVBERi0=', mimeType: 'application/pdf', filename: 'doc.pdf' }],
    });
    const [, , blocks] = enqueue.mock.calls[0];
    expect(blocks[0].type).toBe('resource_link');
    expect(blocks[0].name).toBe('doc.pdf');
    expect(blocks[0].mimeType).toBe('application/pdf');
  });

  it('POST /prompt with multiple files creates multiple blocks', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'compara estas dos imagenes',
      files: [
        { data: 'img1base64', mimeType: 'image/png' },
        { data: 'img2base64', mimeType: 'image/jpeg' },
      ],
    });
    const [, , blocks] = enqueue.mock.calls[0];
    expect(blocks.length).toBe(3); // 2 images + 1 text
    expect(blocks[0].type).toBe('image');
    expect(blocks[1].type).toBe('image');
    expect(blocks[2].type).toBe('text');
  });

  it('POST /prompt with files but no text still enqueues', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: '',
      files: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, , blocks] = enqueue.mock.calls[0];
    expect(blocks.length).toBe(1); // only image, no text block
  });

  it('POST /prompt with files missing data is skipped', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      files: [
        { mimeType: 'image/png' }, // missing data
      ],
    });
    // No blocks created — falls back to text-only
    const [, , blocks] = enqueue.mock.calls[0];
    expect(blocks).toBeUndefined();
  });

  it('POST /prompt backward compat: no files field works as before', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', { text: 'hello', chatId: 42 });
    expect(enqueue).toHaveBeenCalledWith('hello', 42, undefined, undefined);
  });

  it('onComplete callback fires with response when agent finishes', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      callback_url: 'https://example.com/hook',
    });
    // Get the onComplete callback that was passed to enqueue
    const onComplete = enqueue.mock.calls[0][3] as (response: string, error?: string) => void;
    expect(onComplete).toBeDefined();
    // Simulate agent finishing successfully
    onComplete('agent response text');
    // No assertion on fetch — it's fire-and-forget, just verify no throw
  });

  it('onComplete callback fires with error when agent fails', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      callback_url: 'https://example.com/hook',
    });
    const onComplete = enqueue.mock.calls[0][3] as (response: string, error?: string) => void;
    expect(onComplete).toBeDefined();
    // Simulate agent failing
    onComplete('', 'agent crashed');
    // No assertion on fetch — it's fire-and-forget, just verify no throw
  });

  it('POST /prompt without callback_url does not pass onComplete', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'POST', '/prompt', { text: 'hello', chatId: 42 });
    const onComplete = enqueue.mock.calls[0][3];
    expect(onComplete).toBeUndefined();
  });
});
