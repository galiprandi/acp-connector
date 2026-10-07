#!/usr/bin/env node
/**
 * Minimal fake ACP agent for E2E tests — speaks JSON-RPC over stdio.
 *
 * Behaviors:
 * - initialize → capabilities
 * - session/new → returns a session id (mcpServers accepted, ignored)
 * - session/prompt → streams agent_message_chunk(s) + stop.
 *   If the prompt matches `delegate to <peer>: <text>` it POSTs to
 *   `${FAKE_AGENT_BRIDGE}/a2a/delegate` (same path the a2a-network MCP
 *   tools use) and replies with the peer's answer.
 *   Otherwise it echoes: `echo: <prompt>`.
 */
const bridge = process.env.FAKE_AGENT_BRIDGE || '';
// Strict mode: validate session params like a real agent (devin acp rejects
// session/load without mcpServers — the 0.11.1 regression).
const strict = process.env.FAKE_AGENT_STRICT !== '0';
let sessionId = 'fake-session';
const sessions = new Map((process.env.FAKE_AGENT_KNOWN_SESSIONS || '')
  .split(',')
  .filter(Boolean)
  .map((id) => [id, true]));

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function reply(id, result) {
  out({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handlePrompt(id, params) {
  const text = (params.prompt || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  let answer = `echo: ${text}`;
  const m = text.match(/delegate to (\S+): ([\s\S]+)/);
  if (m && bridge) {
    try {
      const res = await fetch(`${bridge}/a2a/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: m[1], text: m[2] }),
      });
      const body = await res.json();
      answer = res.ok ? `peer says: ${body.result}` : `peer error: ${body.error}`;
    } catch (err) {
      answer = `peer unreachable: ${err.message}`;
    }
  }
  // Stream the answer in chunks like a real agent
  out({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } },
    },
  });
  reply(id, { stopReason: 'end_turn' });
}

const rl = (await import('node:readline')).createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg.method) return;
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: false, embeddedContext: false },
        },
      });
      break;
    case 'session/new':
      if (strict && !Array.isArray(msg.params?.mcpServers)) {
        error(msg.id, -32602, 'Invalid params: mcpServers is required');
        break;
      }
      sessionId = 'fake-session';
      sessions.set(sessionId, true);
      reply(msg.id, { sessionId });
      break;
    case 'session/load':
    case 'session/resume': {
      const sid = msg.params?.sessionId;
      if (strict && (!sid || !sessions.has(sid))) {
        error(msg.id, -32602, `Invalid params: unknown sessionId ${sid}`);
        break;
      }
      if (strict && !Array.isArray(msg.params?.mcpServers)) {
        error(msg.id, -32602, 'Invalid params: mcpServers is required');
        break;
      }
      sessionId = sid;
      reply(msg.id, { sessionId: sid, modes: undefined });
      break;
    }
    case 'session/prompt':
      await handlePrompt(msg.id, msg.params);
      break;
    case 'session/cancel':
      break;
    default:
      if (msg.id !== undefined) reply(msg.id, {});
  }
});
