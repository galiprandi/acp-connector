import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * E2E: real bridge (tsx) + fake ACP agent exercising the unified
 * `acp-tools` MCP server end to end — session/new injection, MCP stdio
 * spawn inside the fake agent, tools/call, loopback API, response
 * streamed back through ACP and delivered via the /prompt callbackUrl.
 *
 * Headless mode (HTTP only, LoopbackBot): no messaging platform, so
 * send_file resolves the path but fails at chat resolution — which is
 * exactly what we assert for the allowlist/default-target paths.
 */

const ROOT = resolve(__dirname, '../..');
const FAKE_AGENT = resolve(__dirname, 'fake-agent.mjs');
const BRIDGE = resolve(ROOT, 'src/index.ts');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

interface Spawned {
  dir: string;
  proc: ChildProcess;
  httpPort: number;
}

const spawned: Spawned[] = [];
let portCounter = 17900;
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

/** Capture /prompt callback deliveries. */
function startCallbackSink() {
  const received: Array<{ response?: string; error?: string | null }> = [];
  const waiters: Array<() => void> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({});
      }
      for (const w of waiters.splice(0)) w();
      res.writeHead(200).end();
    });
  });
  return new Promise<{ url: string; server: Server; received: typeof received }>((res) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      res({ url: `http://127.0.0.1:${port}/done`, server, received });
    });
  });
}

async function promptAndWait(
  s: Spawned,
  received: Array<{ response?: string; error?: string | null }>,
  callbackUrl: string,
  text: string
): Promise<{ response?: string; error?: string | null }> {
  const mark = received.length;
  const res = await fetch(`http://127.0.0.1:${s.httpPort}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, callbackUrl }),
  });
  expect(res.status).toBe(200);
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 30000;
    const poll = () => {
      const hit = received.slice(mark).at(-1);
      if (hit) return resolvePromise(hit);
      if (Date.now() > deadline) return reject(new Error(`callback timeout for: ${text}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function spawnBridge(): Promise<Spawned> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-tools-'));
  const httpPort = nextPort();
  writeFileSync(
    join(dir, 'acp-connector.jsonc'),
    JSON.stringify({
      agentCmd: `node ${FAKE_AGENT}`,
      agentCwd: dir,
      http: { enabled: true, port: httpPort, callbackAllow: ['127.0.0.1'] },
      logLevel: 'error',
    })
  );
  const proc = spawn(TSX, [BRIDGE], {
    cwd: dir,
    env: { ...process.env },
    stdio: 'ignore',
  });
  const s = { dir, proc, httpPort };
  spawned.push(s);
  const up = await waitFor(`http://127.0.0.1:${httpPort}/health`);
  expect(up, 'bridge HTTP endpoint did not start').toBe(true);
  return s;
}

afterEach(() => {
  for (const s of spawned.splice(0)) {
    s.proc.kill('SIGTERM');
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe('e2e: acp-tools MCP via fake agent', () => {
  it('injects acp-tools and serves list_aliases through tools/call', async () => {
    const sink = await startCallbackSink();
    const s = await spawnBridge();
    const cb = await promptAndWait(s, sink.received, sink.url, 'call acp-tools.list_aliases {}');
    sink.server.close();
    expect(cb.error).toBeNull();
    expect(cb.response).toContain('aliases');
  }, 60000);

  it('serves unified jobs actions (create + list)', async () => {
    const sink = await startCallbackSink();
    const s = await spawnBridge();

    const created = await promptAndWait(
      s,
      sink.received,
      sink.url,
      'call acp-tools.jobs {"action":"create","in":"1h","prompt":"check deploy"}'
    );
    expect(created.error).toBeNull();
    expect(created.response).toContain('"id"');

    const listed = await promptAndWait(
      s,
      sink.received,
      sink.url,
      'call acp-tools.jobs {"action":"list"}'
    );
    expect(listed.error).toBeNull();
    expect(listed.response).toContain('check deploy');
    sink.server.close();
  }, 90000);

  it('send_file enforces the path allowlist then fails cleanly with no chat', async () => {
    const sink = await startCallbackSink();
    const s = await spawnBridge();
    const allowed = join(s.dir, 'out.txt');
    writeFileSync(allowed, 'e2e file');

    // Path inside agentCwd passes validation; headless has no chat → clean error.
    const inside = await promptAndWait(
      s,
      sink.received,
      sink.url,
      `call acp-tools.send_file {"path":"${allowed}"}`
    );
    expect(inside.error).toBeNull();
    expect(inside.response).toContain('chat');

    // Path outside allowed dirs is rejected before any send attempt.
    const outside = await promptAndWait(
      s,
      sink.received,
      sink.url,
      'call acp-tools.send_file {"path":"/etc/hostname"}'
    );
    expect(outside.error).toBeNull();
    expect(outside.response).toContain('outside allowed');
    sink.server.close();
  }, 90000);
});
