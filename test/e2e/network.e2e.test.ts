import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function peerSecret(s: Spawned, peerId: string): string | undefined {
  try {
    const net = JSON.parse(readFileSync(join(s.dir, '.acp-connector', 'network.json'), 'utf8')) as {
      peers?: Array<{ id: string; auth?: { secret?: string } }>;
    };
    return net.peers?.find((p) => p.id === peerId)?.auth?.secret;
  } catch {
    return undefined;
  }
}

async function waitForPeerSecret(s: Spawned, peerId: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (peerSecret(s, peerId)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`peer secret for ${peerId} never arrived`);
}

async function waitForPeerApproved(s: Spawned, peerId: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const net = JSON.parse(
        readFileSync(join(s.dir, '.acp-connector', 'network.json'), 'utf8')
      ) as { peers?: Array<{ id: string; status?: string }> };
      if (net.peers?.find((p) => p.id === peerId)?.status === 'approved') return;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`peer ${peerId} never approved on ${s.dir}`);
}

function signedHeaders(s: Spawned, senderId: string, receiverId: string, body: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-A2A-Peer-Id': senderId,
  };
  const secret = peerSecret(s, receiverId);
  if (secret) {
    headers['X-A2A-Peer-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
  }
  return headers;
}

async function joinRequest(target: Spawned, id: string, peer: Spawned) {
  return fetch(`http://127.0.0.1:${target.a2aPort}/a2a/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      cardUrl: `http://127.0.0.1:${peer.a2aPort}/.well-known/agent-card.json`,
      card: { name: id, description: `${id} agent` },
    }),
  });
}

/**
 * Full double opt-in pairing required by a2a.secure (default since the
 * hardening release): both sides join, both owners approve, and each side
 * must receive the other's pairing secret before approving locally —
 * otherwise each would mint a different secret and signatures would fail.
 */
async function pairAgents(a: Spawned, b: Spawned): Promise<void> {
  await joinRequest(b, 'alpha', a);
  await joinRequest(a, 'beta', b);
  await sendPrompt(b.httpPort, '/a2a approve alpha');
  await waitForPeerApproved(b, 'alpha');
  await waitForPeerSecret(a, 'beta');
  await sendPrompt(a.httpPort, '/a2a approve beta');
  await waitForPeerApproved(a, 'beta');
  await waitForPeerSecret(b, 'alpha');
}

async function rpcMessageSend(
  sender: Spawned,
  senderId: string,
  receiverId: string,
  a2aPort: number,
  text: string,
  taskId: string
) {
  const body = JSON.stringify({
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
  });
  const res = await fetch(`http://127.0.0.1:${a2aPort}/`, {
    method: 'POST',
    headers: signedHeaders(sender, senderId, receiverId, body),
    body,
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
    await pairAgents(a, b);

    // alpha can send a task to beta — the fake agent echoes back
    const res = await rpcMessageSend(a, 'alpha', 'beta', b.a2aPort, 'ping from alpha', 't-e2e-1');
    expect(res.result.role).toBe('agent');
    const replyText = res.result.parts.map((p: { text?: string }) => p.text).join('');
    expect(replyText).toContain('echo:');
    expect(replyText).toContain('ping from alpha');
  }, 30000);

  it('unapproved peer is rejected before reaching the agent', async () => {
    const b = await spawnAgent('beta');
    const res = await rpcMessageSend(b, 'stranger', 'stranger', b.a2aPort, 'hi', 't-e2e-2');
    expect(res.error.code).toBe(-32001);
  }, 30000);

  it('agent-side delegation: fake agent calls /a2a/delegate to a peer', async () => {
    const a = await spawnAgent('alpha');
    const b = await spawnAgent('beta');

    // Real double opt-in, both directions: each owner approves via /prompt.
    await pairAgents(a, b);

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

  it('message/stream returns SSE events to an approved peer', async () => {
    const a = await spawnAgent('alpha');
    const b = await spawnAgent('beta');
    await pairAgents(a, b);

    const streamBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          role: 'user',
          messageId: 'stream-e2e',
          parts: [{ kind: 'text', text: 'stream test' }],
          metadata: { 'a2a.taskId': 'stream-e2e' },
        },
      },
    });
    const res = await fetch(`http://127.0.0.1:${b.a2aPort}/`, {
      method: 'POST',
      headers: signedHeaders(a, 'alpha', 'beta', streamBody),
      body: streamBody,
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toContain('"state":"working"');
    expect(body).toContain('"state":"completed"');
    expect(body).toContain('stream test');
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

describe('e2e: session resume', () => {
  it('sessionId in config resumes via session/resume with mcpServers (0.11.1 regression)', async () => {
    // Spawn a bridge with a sessionId to resume — the strict fake agent
    // knows 'resume-me' and validates that mcpServers is present in params.
    const a = await spawnAgent('resumer');
    const cfgPath = join(a.dir, 'acp-connector.jsonc');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.sessionId = 'fake-session';
    writeFileSync(cfgPath, JSON.stringify(cfg));

    a.proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    const proc = spawn(TSX, [BRIDGE], {
      cwd: a.dir,
      env: {
        ...process.env,
        FAKE_AGENT_BRIDGE: `http://127.0.0.1:${a.a2aPort}`,
        FAKE_AGENT_KNOWN_SESSIONS: 'fake-session',
      },
      stdio: 'ignore',
    });
    const s2 = { ...a, proc };
    spawned.push(s2);
    const up = await waitFor(`http://127.0.0.1:${a.a2aPort}/.well-known/agent-card.json`, 120);
    expect(up, 'bridge did not resume session').toBe(true);
  }, 60000);
});
