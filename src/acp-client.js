import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

/**
 * Parse JSONC (JSON with comments) — strips line and block comments,
 * respecting string literals so // inside strings (e.g. URLs) is preserved.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseJSONC(text) {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"' && text[i - 1] !== '\\') {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }

    if (inString) {
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return JSON.parse(result);
}

/**
 * ACP client using the official @agentclientprotocol/sdk.
 *
 * Spawns any ACP-compatible agent, initializes the protocol,
 * and exposes an active session for prompting and reading updates.
 */
export class AcpClient {
  /**
   * @param {Object} opts
   * @param {string} opts.agentCmd - Full command to launch the agent (e.g. "acp-agent serve")
   * @param {string} [opts.agentCwd] - Working directory for the subprocess
   * @param {string} [opts.sessionConfigPath] - Path to MCP/session config jsonc
   * @param {string} [opts.sessionId] - Session ID to load/resume
   * @param {Function} [opts.onPermission] - Permission request callback
   */
  constructor({ agentCmd, agentCwd, sessionConfigPath, sessionId, onPermission }) {
    this.agentCmd = agentCmd;
    this.agentCwd = agentCwd || process.cwd();
    this.sessionConfigPath = sessionConfigPath || null;
    this.resumeSessionId = sessionId || null;
    this.onPermission = onPermission || null;
    this.proc = null;
    this.session = null;
    this.protocolVersion = null;
    this.sessionId = null;
    this.modes = null;
    this._keepAlive = null;
    this._disconnect = null;
    this._sessionReady = null;
  }

  _loadSessionConfig() {
    if (!this.sessionConfigPath) return null;
    try {
      const raw = readFileSync(this.sessionConfigPath, 'utf-8');
      return parseJSONC(raw);
    } catch (err) {
      console.error(`Failed to read session config from ${this.sessionConfigPath}: ${err.message}`);
      return null;
    }
  }

  async start() {
    this.proc = spawn(this.agentCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: this.agentCwd,
    });

    this.proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line && /\bERROR\b|\bFATAL\b|\berror:\b|\bfatal:\b|Invalid params/.test(line)) {
        console.error(`⚠️  ${line.slice(0, 200)}`);
      }
    });

    this.proc.on('exit', () => {
      if (this._disconnect) this._disconnect();
    });

    const input = Writable.toWeb(this.proc.stdin);
    const output = Readable.toWeb(this.proc.stdout);
    const stream = acp.ndJsonStream(input, output);

    this._keepAlive = new Promise((resolve) => {
      this._disconnect = resolve;
    });
    this._sessionReady = new Promise((resolve, reject) => {
      this._sessionResolve = resolve;
      this._sessionReject = reject;
    });

    const sessionConfig = this._loadSessionConfig();

    acp
      .client({ name: 'acp-connector', version: '0.1.0' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this._handlePermission(ctx.params)
      )
      .connectWith(stream, async (ctx) => {
        const initResult = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        this.protocolVersion = initResult.protocolVersion;

        let session;
        if (this.resumeSessionId) {
          const loadParams = sessionConfig
            ? { sessionId: this.resumeSessionId, ...sessionConfig }
            : { sessionId: this.resumeSessionId, cwd: this.agentCwd, mcpServers: [] };

          const caps = initResult.agentCapabilities || {};
          const canResume = caps.sessionCapabilities?.resume !== undefined;
          const canLoad = caps.loadSession === true;

          if (canResume) {
            const resumeResponse = await ctx.request(acp.methods.agent.session.resume, loadParams);
            session = ctx.attachSession({ sessionId: this.resumeSessionId, ...resumeResponse });
          } else if (canLoad) {
            const loadResponse = await ctx.request(acp.methods.agent.session.load, loadParams);
            session = ctx.attachSession({ sessionId: this.resumeSessionId, ...loadResponse });
          } else {
            throw new Error('Agent does not support session/resume or session/load');
          }
        } else {
          const builder = sessionConfig
            ? ctx.buildSession(sessionConfig)
            : ctx.buildSession(this.agentCwd);
          session = await builder.start();
        }
        this.session = session;
        this.sessionId = session.sessionId;
        this.modes = session.modes;
        this._sessionResolve();

        await this._keepAlive;
      })
      .catch((err) => {
        if (this._sessionReject) this._sessionReject(err);
      });

    await this._sessionReady;
  }

  async _handlePermission(params) {
    if (this.onPermission) {
      return this.onPermission(params);
    }
    const allowOpt = params.options?.find((o) => o.kind.startsWith('allow'));
    if (allowOpt) {
      return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  async prompt(text) {
    return this.session.prompt(text);
  }

  async nextUpdate() {
    return this.session.nextUpdate();
  }

  kill() {
    if (this.session) this.session.dispose();
    if (this._disconnect) this._disconnect();
    if (this.proc) this.proc.kill();
  }
}
