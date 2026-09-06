import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import type {
  ActiveSession,
  ActiveSessionMessage,
  AgentCapabilities,
  ClientContext,
  InitializeResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptResponse,
  ProtocolVersion,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionModeState,
  Stream,
} from '@agentclientprotocol/sdk';
import * as acp from '@agentclientprotocol/sdk';

/**
 * Parse JSONC (JSON with comments) — strips line and block comments,
 * respecting string literals so // inside strings (e.g. URLs) is preserved.
 * @param text - The JSONC text to parse.
 * @returns The parsed object.
 */
function parseJSONC(text: string): Record<string, unknown> {
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

  return JSON.parse(result) as Record<string, unknown>;
}

/** Callback invoked when the agent requests permission for a tool call. */
type PermissionCallback = (
  params: RequestPermissionRequest
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/** Constructor options for {@link AcpClient}. */
interface AcpClientOptions {
  /** Full command to launch the agent (e.g. "acp-agent serve"). */
  agentCmd: string;
  /** Working directory for the subprocess. */
  agentCwd?: string;
  /** Path to MCP/session config jsonc. */
  sessionConfigPath?: string;
  /** Session ID to load/resume. */
  sessionId?: string;
  /** Permission request callback. */
  onPermission?: PermissionCallback;
}

/**
 * Subset of {@link ClientContext} used during session setup.
 *
 * `attachSession` is private on the public type, so we re-declare the shape we
 * rely on here and cast the context to it.
 */
interface SessionClientContext {
  request: ClientContext['request'];
  buildSession: ClientContext['buildSession'];
  attachSession: (response: NewSessionResponse) => ActiveSession;
}

/**
 * ACP client using the official @agentclientprotocol/sdk.
 *
 * Spawns any ACP-compatible agent, initializes the protocol,
 * and exposes an active session for prompting and reading updates.
 */
export class AcpClient {
  agentCmd: string;
  agentCwd: string;
  sessionConfigPath: string | null;
  resumeSessionId: string | null;
  onPermission: PermissionCallback | null;
  proc: ChildProcess | null;
  session: ActiveSession | null;
  protocolVersion: ProtocolVersion | null;
  sessionId: string | null;
  modes: SessionModeState | null | undefined;
  private _keepAlive: Promise<void> | null;
  private _disconnect: (() => void) | null;
  private _sessionReady: Promise<void> | null;
  private _sessionResolve: (() => void) | null;
  private _sessionReject: ((reason?: unknown) => void) | null;
  private _started: boolean;
  private _killed: boolean;

  /**
   * @param opts - Constructor options.
   */
  constructor({
    agentCmd,
    agentCwd,
    sessionConfigPath,
    sessionId,
    onPermission,
  }: AcpClientOptions) {
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
    this._sessionResolve = null;
    this._sessionReject = null;
    this._started = false;
    this._killed = false;
  }

  _loadSessionConfig(): Record<string, unknown> | null {
    if (!this.sessionConfigPath) return null;
    try {
      const raw = readFileSync(this.sessionConfigPath, 'utf-8');
      return parseJSONC(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to read session config from ${this.sessionConfigPath}: ${message}`);
      return null;
    }
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    this.proc = spawn(this.agentCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: this.agentCwd,
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && /\bERROR\b|\bFATAL\b|\berror:\b|\bfatal:\b|Invalid params/.test(line)) {
        console.error(`⚠️  ${line.slice(0, 200)}`);
      }
    });

    this.proc.on('exit', () => {
      if (this._disconnect) this._disconnect();
    });

    this.proc.on('error', (err: Error) => {
      if (this._sessionReject) this._sessionReject(err);
    });

    const input = Writable.toWeb(this.proc.stdin as Writable);
    const output = Readable.toWeb(this.proc.stdout as Readable);
    const stream: Stream = acp.ndJsonStream(
      input as WritableStream<Uint8Array>,
      output as ReadableStream<Uint8Array>
    );

    this._keepAlive = new Promise<void>((resolve) => {
      this._disconnect = resolve;
    });
    this._sessionReady = new Promise<void>((resolve, reject) => {
      this._sessionResolve = resolve;
      this._sessionReject = reject;
    });

    const sessionConfig = this._loadSessionConfig();

    acp
      .client({ name: 'acp-connector', version: '0.1.0' } as acp.AppOptions)
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this._handlePermission(ctx.params)
      )
      .connectWith(stream, async (rawCtx) => {
        const ctx = rawCtx as unknown as SessionClientContext;
        const initResult: InitializeResponse = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        this.protocolVersion = initResult.protocolVersion;

        let session: ActiveSession;
        if (this.resumeSessionId) {
          const loadParams: ResumeSessionRequest | LoadSessionRequest = sessionConfig
            ? ({
                sessionId: this.resumeSessionId,
                ...(sessionConfig as Partial<ResumeSessionRequest>),
              } as ResumeSessionRequest)
            : {
                sessionId: this.resumeSessionId,
                cwd: this.agentCwd,
                mcpServers: [],
              };

          const caps: AgentCapabilities = initResult.agentCapabilities || {};
          const canResume = caps.sessionCapabilities?.resume !== undefined;
          const canLoad = caps.loadSession === true;

          if (canResume) {
            const resumeResponse = await ctx.request(
              acp.methods.agent.session.resume,
              loadParams as ResumeSessionRequest
            );
            session = ctx.attachSession({
              sessionId: this.resumeSessionId,
              ...(resumeResponse as Partial<NewSessionResponse>),
            } as NewSessionResponse);
          } else if (canLoad) {
            const loadResponse = await ctx.request(
              acp.methods.agent.session.load,
              loadParams as LoadSessionRequest
            );
            session = ctx.attachSession({
              sessionId: this.resumeSessionId,
              ...(loadResponse as Partial<NewSessionResponse>),
            } as NewSessionResponse);
          } else {
            throw new Error('Agent does not support session/resume or session/load');
          }
        } else {
          const builder = sessionConfig
            ? ctx.buildSession(sessionConfig as NewSessionRequest)
            : ctx.buildSession(this.agentCwd);
          session = await builder.start();
        }
        this.session = session;
        this.sessionId = session.sessionId;
        this.modes = session.modes;
        this._sessionResolve?.();

        await this._keepAlive;
      })
      .catch((err: unknown) => {
        if (this._sessionReject) this._sessionReject(err);
      });

    await this._sessionReady;
  }

  async _handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.onPermission) {
      return this.onPermission(params);
    }
    const allowOpt = params.options?.find((o: PermissionOption) => o.kind.startsWith('allow'));
    if (allowOpt) {
      return { outcome: { outcome: 'selected', optionId: allowOpt.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  async prompt(text: string): Promise<PromptResponse> {
    if (!this.session) throw new Error('ACP session not started');
    return this.session.prompt(text);
  }

  async nextUpdate(): Promise<ActiveSessionMessage> {
    if (!this.session) throw new Error('ACP session not started');
    return this.session.nextUpdate();
  }

  kill(): void {
    if (this._killed) return;
    this._killed = true;
    if (this.session) this.session.dispose();
    if (this._disconnect) this._disconnect();
    if (this.proc) this.proc.kill();
  }
}
