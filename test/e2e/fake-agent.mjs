#!/usr/bin/env node
/**
 * Minimal fake ACP agent for E2E tests — speaks JSON-RPC over stdio.
 *
 * Behaviors:
 * - initialize → capabilities
 * - session/new → returns a session id, captures mcpServers
 * - session/load|resume → same, mcpServers required in strict mode
 * - session/prompt → streams agent_message_chunk(s) + stop.
 *   - `delegate to <peer>: <text>` → POSTs to `${FAKE_AGENT_BRIDGE}/a2a/delegate`
 *     and replies with the peer's answer.
 *   - `call <server>.<tool> <json-args>` → lazily spawns the configured MCP
 *     server (stdio), runs initialize + tools/call, replies with the result.
 *   - Otherwise echoes: `echo: <prompt>`.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const bridge = process.env.FAKE_AGENT_BRIDGE || '';
// Strict mode: validate session params like a real agent (devin acp rejects
// session/load without mcpServers — the 0.11.1 regression).
const strict = process.env.FAKE_AGENT_STRICT !== '0';
let sessionId = 'fake-session';
const sessions = new Map(
  (process.env.FAKE_AGENT_KNOWN_SESSIONS || '')
    .split(',')
    .filter(Boolean)
    .map((id) => [id, { mcpServers: [] }])
);

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function reply(id, result) {
  out({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- Minimal MCP stdio client -------------------------------------------
// MCP over stdio is newline-delimited JSON-RPC, same framing as ACP.

class McpClient {
  constructor(spec) {
    this.spec = spec;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
  }

  _ensure() {
    if (this.proc) return;
    const env = { ...process.env };
    for (const e of this.spec.env || []) env[e.name] = e.value;
    this.proc = spawn(this.spec.command, this.spec.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    this.proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('mcp server exited'));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });
  }

  _rpc(method, params) {
    this._ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    if (!this.ready) {
      this.ready = (async () => {
        await this._rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'fake-agent', version: '0.0.0' },
        });
        this.proc.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
        );
      })();
    }
    return this.ready;
  }

  async callTool(name, args) {
    await this.initialize();
    const result = await this._rpc('tools/call', { name, arguments: args });
    const text = (result?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return result?.isError ? `tool error: ${text}` : text || JSON.stringify(result);
  }
}

const mcpClients = new Map(); // serverName -> McpClient

function getClient(spec) {
  if (!mcpClients.has(spec.name)) mcpClients.set(spec.name, new McpClient(spec));
  return mcpClients.get(spec.name);
}

async function tryToolCall(text) {
  // `call <server>.<tool> <json-args>` — args optional, may be preceded by
  // an identity prefix like `[Telegram] Name: `.
  const m = text.match(/(?:^|\s)call\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const [, serverName, toolName, rawArgs] = m;
  const specs = currentSession?.mcpServers || [];
  const spec = specs.find((s) => s.name === serverName);
  if (!spec) return `no mcp server named ${serverName}`;
  let args = {};
  const trimmed = (rawArgs || '').trim();
  if (trimmed) {
    try {
      args = JSON.parse(trimmed);
    } catch {
      return `bad json args: ${trimmed}`;
    }
  }
  try {
    return await getClient(spec).callTool(toolName, args);
  } catch (err) {
    return `tool call failed: ${err.message}`;
  }
}

// --- ACP handling ---------------------------------------------------------

let currentSession = null;

async function handlePrompt(id, params) {
  const text = (params.prompt || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  let answer = `echo: ${text}`;
  const toolResult = await tryToolCall(text);
  if (toolResult !== null) {
    answer = toolResult;
  } else {
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

const rl = createInterface({ input: process.stdin });
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
      currentSession = { mcpServers: msg.params?.mcpServers || [] };
      sessions.set(sessionId, currentSession);
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
      currentSession = sessions.get(sid) || { mcpServers: [] };
      currentSession.mcpServers = msg.params?.mcpServers || currentSession.mcpServers;
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
