import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * End-to-end suite: real acp-connector bridges (spawned via tsx) backed by
 * deterministic fake ACP agents. Covers discovery-adjacent flows that unit
 * tests cannot: real processes, real HTTP, real state files.
 */

const ROOT = resolve(__dirname, '../..');
const FAKE_AGENT = resolve(__dirname, 'fake-agent.mjs');
const BRIDGE = resolve(ROOT, 'src/index.ts');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

interface Spawned {
  dir: string;
  proc: ChildProcess;
  a2aPort: number;
  httpPort: number;
}

const spawned: Spawned[] = [];
let portCounter = 17800;
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

async function spawnAgent(id: string): Promise<Spawned> {
  const dir = mkdtempSync(join(tmpdir(), `e2e-${id}-`));
  const a2aPort = nextPort();
  const httpPort = nextPort();
  writeFileSync(
    join(dir, 'acp-connector.jsonc'),
    JSON.stringify({
      agentCmd: `node ${FAKE_AGENT}`,
      agentCwd: dir,
      http: { enabled: true, port: httpPort },
      a2a: {
        enabled: true,
        id,
        port: a2aPort,
        card: { name: id, description: `${id} agent` },
      },
      logLevel: 'error',
    })
  );
  const proc = spawn(TSX, [BRIDGE], {
    cwd: dir,
    env: { ...process.env, FAKE_AGENT_BRIDGE: `http://127.0.0.1:${a2aPort}` },
    stdio: 'ignore',
  });
  const s = { dir, proc, a2aPort, httpPort };
  spawned.push(s);
  const up = await waitFor(`http://127.0.0.1:${a2aPort}/.well-known/agent-card.json`);
  expect(up, `${id} A2A endpoint did not start`).toBe(true);
  return s;
}

async function sendPrompt(httpPort: number, text: string) {
  // The fake agent answers synchronously; /prompt fire-and-forget is enough —
  // but we need the response. Use the a2a delegate path for assertions and
  // poll the log-free approach: send via /prompt and read via a second call.
  // Simpler: the fake agent's reply is deterministic, so we hit the agent's
  // own bridge /a2a endpoint where possible.
  return fetch(`http://127.0.0.1:${httpPort}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function rpcMessageSend(a2aPort: number, peerId: string, text: string, taskId: string) {
  const res = await fetch(`http://127.0.0.1:${a2aPort}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-A2A-Peer-Id': peerId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          messageId: taskId,
          parts: [{ kind: 'text', text }],
          metadata: { 'a2a.taskId': taskId },
        },
      },
    }),
  });
  return res.json();
}

afterEach(() => {
  for (const s of spawned.splice(0)) {
    s.proc.kill('SIGTERM');
    rmSync(s.dir, { recursive: true, force: true });
  }
});

describe('e2e: two real bridges with fake agents', () => {
  it('join → approve → message/send roundtrip', async () => {
    const a = await spawnAgent('alpha');
    const b = await spawnAgent('beta');

    // alpha discovers beta (simulated) and requests to join
    const joinRes = await fetch(`http://127.0.0.1:${b.a2aPort}/a2a/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'alpha',
        cardUrl: `http://127.0.0.1:${a.a2aPort}/.well-known/agent-card.json`,
        card: { name: 'alpha', description: 'alpha agent' },
      }),
    });
    expect(joinRes.status).toBe(202);

    // beta owner approves via /prompt (operator entry point)
    await sendPrompt(b.httpPort, '/a2a approve alpha');
    await new Promise((r) => setTimeout(r, 500));

    // now alpha can send a task to beta — the fake agent echoes back
    const res = await rpcMessageSend(b.a2aPort, 'alpha', 'ping from alpha', 't-e2e-1');
    expect(res.result.role).toBe('agent');
    const replyText = res.result.parts.map((p: { text?: string }) => p.text).join('');
    expect(replyText).toContain('echo:');
    expect(replyText).toContain('ping from alpha');
  }, 30000);

  it('unapproved peer is rejected before reaching the agent', async () => {
    const b = await spawnAgent('beta');
    const res = await rpcMessageSend(b.a2aPort, 'stranger', 'hi', 't-e2e-2');
    expect(res.error.code).toBe(-32001);
  }, 30000);

  it('agent-side delegation: fake agent calls /a2a/delegate to a peer', async () => {
    const a = await spawnAgent('alpha');
    const b = await spawnAgent('beta');

    // Real double opt-in, both directions: alpha joins beta AND beta
    // joins alpha; each owner approves via /prompt on their bridge.
    await fetch(`http://127.0.0.1:${a.a2aPort}/a2a/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'beta',
        cardUrl: `http://127.0.0.1:${b.a2aPort}/.well-known/agent-card.json`,
        card: { name: 'beta', description: 'beta agent' },
      }),
    });
    await sendPrompt(a.httpPort, '/a2a approve beta');
    await new Promise((r) => setTimeout(r, 800));
    await fetch(`http://127.0.0.1:${b.a2aPort}/a2a/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'alpha',
        cardUrl: `http://127.0.0.1:${a.a2aPort}/.well-known/agent-card.json`,
        card: { name: 'alpha', description: 'alpha agent' },
      }),
    });
    await sendPrompt(b.httpPort, '/a2a approve alpha');
    await new Promise((r) => setTimeout(r, 800));

    // ask alpha's agent (via its own loopback /a2a/delegate) to call beta
    const res = await fetch(`http://127.0.0.1:${a.a2aPort}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'beta', text: 'hello beta' }),
    });
    const body = await res.json();
    if (res.status !== 200) console.log('DELEGATE FAILED:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(body.result).toContain('hello beta');
  }, 45000);

  it('delegation to an unapproved peer is refused (403)', async () => {
    const a = await spawnAgent('alpha');
    const res = await fetch(`http://127.0.0.1:${a.a2aPort}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'nobody', text: 'hi' }),
    });
    expect(res.status).toBe(403);
  }, 30000);
});
