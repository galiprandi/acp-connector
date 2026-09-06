import { describe, expect, it, vi } from 'vitest';

const { HttpServer } = await import('../src/http.js');

function createServer(overrides = {}) {
  const enqueue = vi.fn();
  const getHealth = vi.fn(() => ({ status: 'ok', agent: true, session: 'test-session' }));
  const server = new HttpServer({
    enabled: true,
    port: 0, // use port 0 for ephemeral port in tests
    enqueue,
    getHealth,
    ...overrides,
  });
  return { server, enqueue, getHealth };
}

async function fetchServer(server, method, path, body = null) {
  const port = server._server?.address()?.port;
  if (!port) throw new Error('server not started');
  const url = `http://localhost:${port}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('HttpServer', () => {
  it('does not start when enabled is false', () => {
    const { server } = createServer({ enabled: false });
    server.start();
    expect(server._server).toBeNull();
  });

  it('GET /health returns 200 with health info', async () => {
    const { server, getHealth } = createServer();
    server.start();
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(getHealth).toHaveBeenCalled();
    server.stop();
  });

  it('POST /prompt enqueues a prompt', async () => {
    const { server, enqueue } = createServer();
    server.start();
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello', chatId: 123 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', 123);
    server.stop();
  });

  it('POST /prompt with no text returns 400', async () => {
    const { server } = createServer();
    server.start();
    const res = await fetchServer(server, 'POST', '/prompt', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('text is required');
    server.stop();
  });

  it('unknown route returns 404', async () => {
    const { server } = createServer();
    server.start();
    const res = await fetchServer(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    server.stop();
  });

  it('stop() closes the server', async () => {
    const { server } = createServer();
    server.start();
    server.stop();
    expect(server._server).toBeNull();
  });
});
