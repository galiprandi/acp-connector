import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
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
    port: 0, // use port 0 for ephemeral port in tests
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
  body: Record<string, unknown> | null = null
): Promise<{ status: number; body: unknown }> {
  const port = server._server?.address()?.port;
  if (!port) throw new Error('server not started');
  const url = `http://localhost:${port}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
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
    await server.start();
    const res = await fetchServer(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(getHealth).toHaveBeenCalled();
    server.stop();
  });

  it('POST /prompt enqueues a prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    const res = await fetchServer(server, 'POST', '/prompt', { text: 'hello', chatId: 123 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', 123, undefined, undefined);
    server.stop();
  });

  it('POST /prompt with callback_url passes onComplete to enqueue', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    const res = await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      chatId: 123,
      callback_url: 'https://example.com/hook',
    });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith('hello', 123, undefined, expect.any(Function));
    server.stop();
  });

  it('POST /prompt with callbackUrl (camelCase) passes onComplete to enqueue', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    const res = await fetchServer(server, 'POST', '/prompt', {
      text: 'hello',
      chatId: 123,
      callbackUrl: 'https://example.com/hook',
    });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith('hello', 123, undefined, expect.any(Function));
    server.stop();
  });

  it('POST /prompt with JSON body but no text field uses raw body as prompt', async () => {
    const { server, enqueue } = createServer();
    await server.start();
    const res = await fetchServer(server, 'POST', '/prompt', { foo: 'bar' });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledOnce();
    server.stop();
  });

  it('unknown route returns 404', async () => {
    const { server } = createServer();
    await server.start();
    const res = await fetchServer(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    server.stop();
  });

  it('stop() closes the server', async () => {
    const { server } = createServer();
    await server.start();
    server.stop();
    expect(server._server).toBeNull();
  });
});
