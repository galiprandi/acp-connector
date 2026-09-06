import { afterEach, describe, expect, it, vi } from 'vitest';

const { HttpServer } = await import('../src/http.js');

function createServer(overrides = {}) {
  const enqueue = vi.fn();
  const getHealth = vi.fn(() => ({ status: 'ok', agent: true, session: 'test-session' }));
  const server = new HttpServer({
    enabled: true,
    port: 0, // ephemeral port
    enqueue,
    getHealth,
    ...overrides,
  });
  return { server, enqueue, getHealth };
}

/**
 * Fetch helper that supports raw (non-JSON) bodies for edge-case testing.
 * @param {HttpServer} server
 * @param {string} method
 * @param {string} path
 * @param {string | object | null} body - string = raw body, object = JSON, null = no body
 * @param {Record<string, string>} [headers]
 */
async function fetchServer(server, method, path, body = null, headers = {}) {
  const port = server._server?.address()?.port;
  if (!port) throw new Error('server not started');
  const url = `http://localhost:${port}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed = null;
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
  /** @type {Array<() => void>} */
  const cleanup = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  it('POST /prompt with no body returns 400', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', null);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with invalid JSON returns 400', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', '{ not valid json,,, }');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with empty text returns 400', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('text is required');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with whitespace-only text returns 400', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('text is required');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /prompt with text but no chatId enqueues with undefined (default)', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', undefined);
  });

  it('GET /unknown route returns 404', async () => {
    const { server } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });

  it('POST /unknown route returns 404', async () => {
    const { server } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/unknown', { foo: 'bar' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });

  it('double stop() is idempotent and does not throw', () => {
    const { server } = createServer();
    server.start();
    expect(() => {
      server.stop();
      server.stop();
    }).not.toThrow();
    expect(server._server).toBeNull();
  });

  it('health check with no agent session (default getHealth) returns 200 ok', async () => {
    const { server } = createServer({ getHealth: null });
    server.start();
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
    const { server } = createServer({ getHealth });
    server.start();
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
    // stop should be a no-op and not throw
    expect(() => server.stop()).not.toThrow();
  });

  it('POST /prompt with large body (>10KB) is accepted', async () => {
    const { server, enqueue } = createServer();
    server.start();
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
    server.start();
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
    expect(enqueue).toHaveBeenCalledWith('hello', 42);
  });

  it('POST /prompt with non-string text (number) returns 400', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    const res = await fetchServer(server, 'POST', '/prompt', { text: 123 });
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('GET /health does not call enqueue', async () => {
    const { server, enqueue } = createServer();
    server.start();
    cleanup.push(() => server.stop());
    await fetchServer(server, 'GET', '/health');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
