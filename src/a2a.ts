import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AgentCard, buildAgentCard } from './agent-card.js';
import type { A2aConfig } from './config.js';
import type { EnqueueFn } from './http.js';
import { log } from './logger.js';
import type { AuditLog, NetworkStore } from './network.js';

/** Peer identity header. Phase-1 trust model: the id must be an approved peer. */
export const PEER_ID_HEADER = 'x-a2a-peer-id';

const ERR_UNAUTHORIZED = -32001;
const ERR_DUPLICATE_TASK = -32002;
const ERR_LOOP = -32003;

export interface A2aServerOptions {
  config: A2aConfig;
  network: NetworkStore;
  selfId: string;
  enqueue: EnqueueFn;
  /** Called when a peer POSTs /a2a/join — deployment glue, not part of A2A. */
  onJoin?: (req: { id: string; cardUrl: string; card?: Record<string, unknown> }) => Promise<void>;
  /** Called when an approved peer confirms us back (double opt-in completes). */
  onConfirm?: (peerId: string) => Promise<void>;
  /** Optional audit trail for inbound/outbound tasks. */
  audit?: AuditLog;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: {
    message?: {
      role: string;
      messageId: string;
      parts: Array<{ kind: string; text?: string }>;
      metadata?: Record<string, unknown>;
    };
  };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * A2A endpoint: serves the Agent Card and the JSON-RPC binding
 * (`message/send`). Inbound A2A messages become queued prompts; the
 * agent's reply is returned as an agent Message. Only approved peers
 * may send tasks — anything else is rejected before parsing intent.
 */
export class A2aServer {
  enqueue: EnqueueFn;
  private _server: Server | null = null;
  private _card: AgentCard;

  constructor(private opts: A2aServerOptions) {
    this.enqueue = opts.enqueue;
    const host = opts.config.host ?? '127.0.0.1';
    const port = opts.config.port ?? 7741;
    this._card = buildAgentCard(opts.config, `http://${host}:${port}`);
  }

  start(): Promise<void> {
    if (!this.opts.config.enabled) return Promise.resolve();

    this._server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
          res.writeHead(200);
          res.end(JSON.stringify(this._card));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/a2a/join') {
          const body = await readBody(req);
          const join = JSON.parse(body) as {
            id?: string;
            cardUrl?: string;
            card?: Record<string, unknown>;
          };
          if (!join.id || !join.cardUrl) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'id and cardUrl are required' }));
            return;
          }
          await this.opts.onJoin?.({ id: join.id, cardUrl: join.cardUrl, card: join.card });
          res.writeHead(202);
          res.end(JSON.stringify({ status: 'pending-approval' }));
          return;
        }
        if (url.pathname === '/a2a/peers' || url.pathname === '/a2a/delegate') {
          // Agent-facing surface: loopback only. When the A2A endpoint is
          // exposed to a LAN, remote peers must never be able to list our
          // internal view or delegate in the agent's name.
          if (!isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'loopback only' }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/a2a/peers') {
            const peers = this.opts.network.listPeers('approved').map((p) => ({
              id: p.id,
              cardUrl: p.cardUrl,
              name: (p.card?.name as string) ?? p.id,
              skills: Array.isArray(p.card?.skills)
                ? (p.card.skills as Array<{ id: string; description?: string }>).map((s) => s.id)
                : [],
              lastSeen: p.lastSeen,
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ peers }));
            return;
          }
          if (req.method === 'POST' && url.pathname === '/a2a/delegate') {
            await this._handleDelegate(req, res);
            return;
          }
        }
        if (url.pathname.startsWith('/a2a/registry/')) {
          await this._handleRegistry(req, res, url);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/a2a/confirm') {
          const body = await readBody(req);
          const confirm = JSON.parse(body) as { id?: string };
          if (!confirm.id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'id is required' }));
            return;
          }
          await this.opts.onConfirm?.(confirm.id);
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/') {
          await this._handleRpc(req, res);
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });

    return new Promise((resolve) => {
      this._server?.listen(
        this.opts.config.port ?? 7741,
        this.opts.config.host ?? '127.0.0.1',
        () => {
          const addr = this.address();
          const port = addr && typeof addr !== 'string' ? addr.port : this.opts.config.port;
          this._card.url = `http://${this.opts.config.host ?? '127.0.0.1'}:${port}`;
          log.info(`🤝 A2A endpoint on ${this.opts.config.host ?? '127.0.0.1'}:${port}`);
          resolve();
        }
      );
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
  }

  /** Public URL of this agent's card (set after start() resolves the port). */
  cardUrl(): string {
    return this._card.url;
  }

  address(): AddressInfo | string | null {
    return this._server?.address() ?? null;
  }

  /**
   * Registry-mode endpoints (ADR-004): a discovery-only directory that
   * stores approved peers' Agent Cards and answers capability queries.
   * It never sees task content. Deliberately unstandardized glue — the
   * A2A spec does not define registry APIs. Active only when
   * `network.role === 'registry'`; otherwise 404.
   */
  private async _handleRegistry(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    if (this.opts.network.role !== 'registry') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/a2a/registry/agents') {
      const skill = url.searchParams.get('skill');
      const agents = this.opts.network
        .listPeers('approved')
        .filter((peer) => {
          if (!skill) return true;
          const skills = (peer.card?.skills ?? []) as Array<{ id?: string }>;
          return Array.isArray(skills) && skills.some((s) => s?.id === skill);
        })
        .map((peer) => ({ id: peer.id, cardUrl: peer.cardUrl, card: peer.card }));
      res.writeHead(200);
      res.end(JSON.stringify({ agents }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/a2a/registry/announce') {
      const body = await readBody(req);
      const announce = JSON.parse(body) as {
        id?: string;
        cardUrl?: string;
        card?: Record<string, unknown>;
      };
      const peer = announce.id ? this.opts.network.getPeer(announce.id) : undefined;
      if (peer?.status !== 'approved') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'peer not approved' }));
        return;
      }
      if (announce.cardUrl) peer.cardUrl = announce.cardUrl;
      if (announce.card) peer.card = announce.card;
      peer.lastSeen = new Date().toISOString();
      this.opts.network.save();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private async _handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }

    const streaming = rpc.method === 'message/stream';
    if (rpc.method !== 'message/send' && !streaming) {
      res.writeHead(200);
      res.end(JSON.stringify(rpcError(rpc.id ?? null, -32601, `Method not found: ${rpc.method}`)));
      return;
    }

    const peerId = String(req.headers[PEER_ID_HEADER] ?? '');
    if (!peerId || !this.opts.network.isApproved(peerId)) {
      this.opts.audit?.write({
        event: 'task_rejected',
        peer: peerId || 'unknown',
        detail: 'not approved',
      });
      res.writeHead(200);
      res.end(JSON.stringify(rpcError(rpc.id, ERR_UNAUTHORIZED, 'Peer is not approved')));
      return;
    }

    const msg = rpc.params?.message;
    const taskId = String(msg?.metadata?.['a2a.taskId'] ?? msg?.messageId ?? '');
    const chain = (msg?.metadata?.['a2a.delegationChain'] as string[] | undefined) ?? [];

    try {
      this.opts.network.checkDelegationChain(chain, this.opts.selfId);
    } catch (err) {
      res.writeHead(200);
      res.end(JSON.stringify(rpcError(rpc.id, ERR_LOOP, (err as Error).message)));
      return;
    }

    if (taskId && this.opts.network.hasSeenTask(taskId)) {
      res.writeHead(200);
      res.end(JSON.stringify(rpcError(rpc.id, ERR_DUPLICATE_TASK, `Duplicate task: ${taskId}`)));
      return;
    }
    if (taskId) this.opts.network.markTaskSeen(taskId);
    this.opts.audit?.write({ event: 'task_in', peer: peerId, taskId });

    const text = (msg?.parts ?? [])
      .filter((p) => p.kind === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');

    // contextId groups related tasks into a conversation (spec); we echo it
    // back so clients can correlate streams. Semantics stay per-task.
    const contextId = String(
      (msg as { contextId?: string } | undefined)?.contextId ??
        (rpc.params as { contextId?: string } | undefined)?.contextId ??
        taskId
    );
    const prefixed = `[A2A from ${peerId}${taskId ? ` | task ${taskId}` : ''}]\n${text}`;

    if (streaming) {
      await this._handleStream(res, prefixed, taskId || `task-${Date.now()}`, contextId);
      this.opts.network.save();
      return;
    }

    const reply = await this._enqueueAndWait(prefixed);
    this.opts.network.save();

    res.writeHead(200);
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          role: 'agent',
          messageId: `a2a-${Date.now()}`,
          contextId,
          parts: [{ kind: 'text', text: reply }],
        },
      })
    );
  }

  /**
   * Outbound delegation on behalf of the local agent: sends a
   * `message/send` to an approved peer and resolves with its reply.
   */
  private async _handleDelegate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as { to?: string; text?: string; taskId?: string };
    if (!body.to || !body.text) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'to and text are required' }));
      return;
    }
    if (!this.opts.network.isApproved(body.to)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: `peer not approved: ${body.to}` }));
      return;
    }
    const peer = this.opts.network.getPeer(body.to);
    if (!peer?.cardUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `no cardUrl for peer: ${body.to}` }));
      return;
    }
    const taskId = body.taskId ?? `d-${Date.now()}`;
    this.opts.audit?.write({ event: 'task_out', peer: body.to, taskId });
    const origin = new URL(peer.cardUrl).origin;
    const rpcRes = await fetch(`${origin}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [PEER_ID_HEADER]: this.opts.selfId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: taskId,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            messageId: taskId,
            parts: [{ kind: 'text', text: body.text }],
            metadata: { 'a2a.taskId': taskId, 'a2a.delegationChain': [this.opts.selfId] },
          },
        },
      }),
    });
    const rpcBody = (await rpcRes.json()) as {
      error?: { code: number; message: string };
      result?: { parts?: Array<{ kind: string; text?: string }> };
    };
    if (rpcBody.error) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: rpcBody.error.message }));
      return;
    }
    const text = (rpcBody.result?.parts ?? []).map((p) => p.text ?? '').join('\n');
    res.writeHead(200);
    res.end(JSON.stringify({ result: text }));
  }

  /**
   * message/stream: SSE stream of A2A events —
   * Task(working) → TaskStatusUpdateEvent per chunk → completed(final).
   * Event ids are monotonically increasing within the request so clients
   * can resume via Last-Event-ID if needed.
   */
  private async _handleStream(
    res: ServerResponse,
    text: string,
    taskId: string,
    contextId: string
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let seq = 0;
    const send = (event: string, data: unknown) => {
      res.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('task', {
      id: taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      kind: 'task',
    });

    const reply = await this._enqueueAndWait(text, (chunk) =>
      send('status', {
        taskId,
        contextId,
        status: {
          state: 'working',
          message: {
            role: 'agent',
            messageId: `${taskId}-${seq}`,
            parts: [{ kind: 'text', text: chunk }],
          },
        },
        final: false,
        kind: 'status-update',
      })
    );

    send('status', {
      taskId,
      contextId,
      status: {
        state: 'completed',
        message: {
          role: 'agent',
          messageId: `${taskId}-final`,
          parts: [{ kind: 'text', text: reply }],
        },
      },
      final: true,
      kind: 'status-update',
    });
    res.end();
  }

  private _enqueueAndWait(text: string, onChunk?: (chunk: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.enqueue(
          text,
          undefined,
          undefined,
          (response, error) => {
            if (error) reject(new Error(error));
            else resolve(response);
          },
          onChunk
        );
      } catch (err) {
        reject(err as Error);
      }
    });
  }
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
