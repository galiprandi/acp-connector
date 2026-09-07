import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import type {
  ActiveSession,
  ActiveSessionMessage,
  AgentCapabilities,
  ClientContext,
  ContentBlock,
  InitializeResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptCapabilities,
  PromptResponse,
  ProtocolVersion,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionInfo,
  SessionModeState,
  SetSessionModeRequest,
  Stream,
} from '@agentclientprotocol/sdk';
import * as acp from '@agentclientprotocol/sdk';
import { stripJsonc } from './config';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

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
  /** Initial session mode to set after session creation/load. */
  sessionMode?: string;
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
  notify: ClientContext['notify'];
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
  initialSessionMode: string | null;
  onPermission: PermissionCallback | null;
  proc: ChildProcess | null;
  session: ActiveSession | null;
  protocolVersion: ProtocolVersion | null;
  sessionId: string | null;
  modes: SessionModeState | null | undefined;
  promptCapabilities: PromptCapabilities | null;
  agentCapabilities: AgentCapabilities | null;
  private _ctx: SessionClientContext | null;
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
    sessionMode,
    onPermission,
  }: AcpClientOptions) {
    this.agentCmd = agentCmd;
    this.agentCwd = agentCwd || process.cwd();
    this.sessionConfigPath = sessionConfigPath || null;
    this.resumeSessionId = sessionId || null;
    this.initialSessionMode = sessionMode || null;
    this.onPermission = onPermission || null;
    this.proc = null;
    this.session = null;
    this.protocolVersion = null;
    this.sessionId = null;
    this.modes = null;
    this.promptCapabilities = null;
    this.agentCapabilities = null;
    this._ctx = null;
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
      return JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
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
      .client({ name: 'acp-connector', version: pkg.version } as acp.AppOptions)
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this._handlePermission(ctx.params)
      )
      .connectWith(stream, async (rawCtx) => {
        const ctx = rawCtx as unknown as SessionClientContext;
        this._ctx = ctx;
        const initResult: InitializeResponse = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        this.protocolVersion = initResult.protocolVersion;
        this.promptCapabilities = initResult.agentCapabilities?.promptCapabilities || null;
        this.agentCapabilities = initResult.agentCapabilities || null;

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
        if (this.initialSessionMode) {
          try {
            await this.setSessionMode(this.initialSessionMode);
          } catch (err) {
            console.warn(
              `⚠️ Failed to set initial session mode "${this.initialSessionMode}": ${(err as Error).message}`
            );
          }
        }
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

  async prompt(text: string | ContentBlock | ContentBlock[]): Promise<PromptResponse> {
    if (!this.session) throw new Error('ACP session not started');
    return this.session.prompt(text);
  }

  async nextUpdate(): Promise<ActiveSessionMessage> {
    if (!this.session) throw new Error('ACP session not started');
    return this.session.nextUpdate();
  }

  async cancel(): Promise<void> {
    if (!this.session) throw new Error('ACP session not started');
    if (!this._ctx) throw new Error('ACP context not available');
    await this._ctx.notify(acp.methods.agent.session.cancel, {
      sessionId: this.session.sessionId,
    });
  }

  /**
   * Close the current session cleanly via `session/close`.
   * Not all agents support this method — failures are non-fatal.
   */
  async closeSession(): Promise<void> {
    if (!this._ctx) return;
    if (!this.sessionId) return;
    try {
      await this._ctx.request(acp.methods.agent.session.close, {
        sessionId: this.sessionId,
      });
    } catch {
      // Agent doesn't support session/close — non-fatal, dispose instead
    }
  }

  /**
   * Delete a session from the agent's session list via `session/delete`.
   * Requires `sessionCapabilities.delete` capability.
   * @param sessionId - The session ID to delete.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this._ctx) throw new Error('ACP context not available');
    const caps = this.agentCapabilities;
    if (!caps?.sessionCapabilities?.delete) {
      throw new Error('Agent does not support session/delete');
    }
    await this._ctx.request(acp.methods.agent.session.delete, {
      sessionId,
    });
  }

  /**
   * Close the current session and create a new one with fresh context.
   * Attempts `session/close` before disposing (non-fatal if unsupported).
   * @returns The new session ID.
   */
  async newSession(): Promise<string> {
    if (!this._ctx) throw new Error('ACP context not available');
    await this.closeSession();
    if (this.session) this.session.dispose();
    const sessionConfig = this._loadSessionConfig();
    const builder = sessionConfig
      ? this._ctx.buildSession(sessionConfig as NewSessionRequest)
      : this._ctx.buildSession(this.agentCwd);
    const session = await builder.start();
    this.session = session;
    this.sessionId = session.sessionId;
    this.modes = session.modes;
    if (this.initialSessionMode) {
      try {
        await this.setSessionMode(this.initialSessionMode);
      } catch (err) {
        console.warn(
          `⚠️ Failed to set initial session mode "${this.initialSessionMode}": ${(err as Error).message}`
        );
      }
    }
    return session.sessionId;
  }

  /**
   * List available sessions from the agent.
   * Requires `sessionCapabilities.list` capability.
   * @returns Array of session info objects.
   */
  async listSessions(): Promise<SessionInfo[]> {
    if (!this._ctx) throw new Error('ACP context not available');
    const caps = this.agentCapabilities;
    if (!caps?.sessionCapabilities?.list) {
      throw new Error('Agent does not support session/list');
    }
    const response = await this._ctx.request(acp.methods.agent.session.list, {});
    return (response as { sessions: SessionInfo[] }).sessions;
  }

  /**
   * Switch to an existing session by ID.
   * Uses `session/resume` if available, falls back to `session/load`.
   * @param sessionId - The session ID to switch to.
   * @returns The session ID (same as input).
   */
  async loadSession(sessionId: string): Promise<string> {
    if (!this._ctx) throw new Error('ACP context not available');
    const caps = this.agentCapabilities || {};
    const canResume = caps.sessionCapabilities?.resume !== undefined;
    const canLoad = caps.loadSession === true;
    if (!canResume && !canLoad) {
      throw new Error('Agent does not support session/resume or session/load');
    }

    if (this.session) this.session.dispose();

    const sessionConfig = this._loadSessionConfig();
    const loadParams: ResumeSessionRequest | LoadSessionRequest = sessionConfig
      ? ({ sessionId, ...(sessionConfig as Partial<ResumeSessionRequest>) } as ResumeSessionRequest)
      : { sessionId, cwd: this.agentCwd, mcpServers: [] };

    let response: Partial<NewSessionResponse>;
    if (canResume) {
      response = await this._ctx.request(
        acp.methods.agent.session.resume,
        loadParams as ResumeSessionRequest
      );
    } else {
      response = await this._ctx.request(
        acp.methods.agent.session.load,
        loadParams as LoadSessionRequest
      );
    }

    const session = this._ctx.attachSession({
      sessionId,
      ...(response as Partial<NewSessionResponse>),
    } as NewSessionResponse);
    this.session = session;
    this.sessionId = session.sessionId;
    this.modes = session.modes;
    if (this.initialSessionMode) {
      try {
        await this.setSessionMode(this.initialSessionMode);
      } catch (err) {
        console.warn(
          `⚠️ Failed to set initial session mode "${this.initialSessionMode}": ${(err as Error).message}`
        );
      }
    }
    return session.sessionId;
  }

  /**
   * Set the current session mode via `session/set_mode`.
   * @param modeId - The mode ID to set (must be one of availableModes).
   * @returns void
   */
  async setSessionMode(modeId: string): Promise<void> {
    if (!this._ctx) throw new Error('ACP context not available');
    if (!this.sessionId) throw new Error('No active session');
    await this._ctx.request(acp.methods.agent.session.setMode, {
      sessionId: this.sessionId,
      modeId,
    } as SetSessionModeRequest);
    if (this.modes) {
      this.modes.currentModeId = modeId;
    }
  }

  kill(): void {
    if (this._killed) return;
    this._killed = true;
    if (this.session) this.session.dispose();
    if (this._disconnect) this._disconnect();
    if (this.proc) this.proc.kill();
  }
}
