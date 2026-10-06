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
let sessionId = 'fake-session';

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function reply(id, result) {
  out({ jsonrpc: '2.0', id, result });
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
        agentCapabilities: { promptCapabilities: { image: false, embeddedContext: false } },
      });
      break;
    case 'session/new':
      sessionId = 'fake-session';
      reply(msg.id, { sessionId });
      break;
    case 'session/prompt':
      await handlePrompt(msg.id, msg.params);
      break;
    case 'session/cancel':
      break;
    default:
      if (msg.id !== undefined) reply(msg.id, {});
  }
});
