import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * E2E: a real acp-connector (tsx) backed by the deterministic fake agent,
 * with a live HTTP receiver asserting that configured events actually
 * arrive over the wire — allowlist filtering, signature and routing
 * context included.
 */

const ROOT = resolve(__dirname, '../..');
const FAKE_AGENT = resolve(__dirname, 'fake-agent.mjs');
const BRIDGE = resolve(ROOT, 'src/index.ts');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const SECRET = 'e2e-webhook-secret';

interface Delivery {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> & { event?: string; data?: Record<string, unknown> };
}

const spawned: Array<{ dir: string; proc: ChildProcess }> = [];
const servers: Server[] = [];
let portCounter = 18800;
const nextPort = () => ++portCounter;

async function waitFor(url: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Start a receiver that collects POSTed webhook payloads. */
async function startReceiver(): Promise<{ port: number; deliveries: Delivery[] }> {
  const deliveries: Delivery[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(200).end('ok');
    });
  });
  const port = nextPort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  servers.push(server);
  return { port, deliveries };
}

async function waitForEvent(
  deliveries: Delivery[],
  event: string,
  tries = 60
): Promise<Delivery | undefined> {
  for (let i = 0; i < tries; i++) {
    const hit = deliveries.find((d) => d.body.event === event);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

async function spawnBridge(webhookPort: number, filteredPort: number) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-webhooks-'));
  const httpPort = nextPort();
  writeFileSync(
    join(dir, 'acp-connector.jsonc'),
    JSON.stringify({
      agentCmd: `node ${FAKE_AGENT}`,
      agentCwd: dir,
      http: { enabled: true, port: httpPort },
      webhooks: [
        {
          url: `http://127.0.0.1:${webhookPort}/sink`,
          events: ['*'],
          secret: SECRET,
          headers: { 'x-extra': 'custom' },
        },
        {
          url: `http://127.0.0.1:${filteredPort}/jobs-only`,
          events: ['job.*'],
        },
      ],
      logLevel: 'error',
    })
  );
  const proc = spawn(TSX, [BRIDGE], { cwd: dir, stdio: 'ignore' });
  spawned.push({ dir, proc });
  const up = await waitFor(`http://127.0.0.1:${httpPort}/health`);
  expect(up, 'bridge did not start').toBe(true);
  return { dir, proc, httpPort };
}

afterEach(async () => {
  for (const s of spawned.splice(0)) {
    s.proc.kill('SIGTERM');
    rmSync(s.dir, { recursive: true, force: true });
  }
  for (const srv of servers.splice(0)) {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

describe('e2e: outbound event webhooks', () => {
  it('delivers lifecycle + prompt events with signature and routing context', async () => {
    const recv = await startReceiver();
    const filtered = await startReceiver();
    const { httpPort } = await spawnBridge(recv.port, filtered.port);

    // Startup events
    const started = await waitForEvent(recv.deliveries, 'bridge.started');
    expect(started, 'bridge.started never arrived').toBeTruthy();
    expect(started?.body.data?.agentCmd).toContain('fake-agent');
    const sessionChanged = await waitForEvent(recv.deliveries, 'session.changed');
    expect(sessionChanged?.body.data?.sessionId).toBe('fake-session');

    // Drive one prompt through the real queue via POST /prompt
    const res = await fetch(`http://127.0.0.1:${httpPort}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello webhook' }),
    });
    expect(res.status).toBe(200);

    for (const ev of ['prompt.received', 'prompt.started', 'prompt.completed']) {
      const hit = await waitForEvent(recv.deliveries, ev);
      expect(hit, `${ev} never arrived`).toBeTruthy();
      expect(hit?.body.source).toBe('http');
      expect(hit?.body.platform).toBe('loopback');
    }

    const received = await waitForEvent(recv.deliveries, 'prompt.received');
    expect(received?.body.data?.text).toBe('hello webhook');
    const completed = await waitForEvent(recv.deliveries, 'prompt.completed');
    expect(completed?.body.data?.response).toContain('echo:');
    expect(completed?.body.data?.text).toBe('hello webhook');
    expect(typeof completed?.body.data?.durationMs).toBe('number');

    // Signature + headers on every delivery to the '*' endpoint
    for (const d of recv.deliveries) {
      expect(d.headers['x-acp-event']).toBe(d.body.event);
      expect(d.headers['x-extra']).toBe('custom');
      const expected = `sha256=${createHmac('sha256', SECRET)
        .update(JSON.stringify(d.body))
        .digest('hex')}`;
      expect(d.headers['x-acp-signature']).toBe(expected);
    }

    // The jobs-only endpoint saw none of the prompt/lifecycle traffic
    await new Promise((r) => setTimeout(r, 500));
    expect(filtered.deliveries).toHaveLength(0);
  }, 45000);

  it('emits bridge.stopping on shutdown', async () => {
    const recv = await startReceiver();
    const filtered = await startReceiver();
    const { proc } = await spawnBridge(recv.port, filtered.port);
    await waitForEvent(recv.deliveries, 'bridge.started');
    proc.kill('SIGINT');
    const stopping = await waitForEvent(recv.deliveries, 'bridge.stopping', 40);
    expect(stopping, 'bridge.stopping never arrived').toBeTruthy();
    expect(stopping?.body.data?.signal).toBe('SIGINT');
  }, 45000);
});
