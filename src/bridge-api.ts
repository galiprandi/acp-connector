import { realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, resolve, sep } from 'node:path';
import type { AliasDirectory } from './aliases.js';
import type { Job, JobManager, JobTrigger } from './jobs.js';
import { everyToCron, formatFiresAt, needsExplicitTimezone, parseWhenTime } from './jobs.js';
import { log } from './logger.js';

/**
 * Loopback HTTP API backing the `acp-tools` MCP stdio server. The MCP
 * server runs inside the agent process; this API is how its tools reach
 * the bridge's job scheduler, chat alias directory and messaging
 * transports.
 *
 * Bound to 127.0.0.1 on an ephemeral port, no auth — same trust model
 * as the A2A loopback endpoints (the agent is already fully trusted).
 */

const MAX_BODY = 64 * 1024;
/** Default cap for agent-sent files — Telegram bot uploads max ~50MB. */
export const DEFAULT_MAX_FILE_BYTES = 45 * 1024 * 1024;
const CAPTION_MAX = 1024;

type Json = Record<string, unknown>;

function _send(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function _ok(res: ServerResponse, body: Json = {}): void {
  _send(res, 200, { ok: true, ...body });
}

function _err(res: ServerResponse, error: string, status = 400): void {
  _send(res, status, { ok: false, error });
}

async function _readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) throw new Error('body too large');
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function _str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** How the API delivers agent-requested file sends to a platform chat. */
export interface FileSendHandlers {
  /**
   * Resolve `to` (agent alias like `Telegram/Familia`, or the bracketed
   * prompt form) to a platform chat. Undefined `to` = current chat.
   */
  resolve(
    to: string | undefined
  ): { platform: string; chatId: string | number; alias: string } | { error: string };
  /** Deliver the file through the platform transport. */
  send(
    platform: string,
    chatId: string | number,
    filePath: string,
    caption?: string
  ): Promise<void>;
}

export interface BridgeApiOptions {
  jobs: JobManager;
  /**
   * IANA timezone (`config.timezone`) for absolute times without an
   * explicit zone. Required for naive absolute times — unset means they
   * are rejected rather than guessed against the host's system zone.
   */
  timezone?: string;
  /** Chat alias directory powering list_aliases + send_file `to`. */
  aliases?: AliasDirectory | null;
  /** File delivery plumbing (alias → platform chat → transport). */
  fileSend?: FileSendHandlers;
  /**
   * Directories the agent may send files from (realpath containment).
   * Defaults to the process cwd when unset — bridge.ts always passes
   * the configured set (agent cwd + uploads dir + tmpdir).
   */
  allowedPaths?: string[];
  /** Max file size in bytes (default DEFAULT_MAX_FILE_BYTES). */
  maxFileSizeBytes?: number;
}

/**
 * Shared handler — exported for tests so tools can be exercised without
 * spawning the MCP server.
 */
export function createBridgeApiHandler({
  jobs,
  timezone,
  aliases,
  fileSend,
  allowedPaths,
  maxFileSizeBytes = DEFAULT_MAX_FILE_BYTES,
}: BridgeApiOptions) {
  const now = () => Date.now();

  // Pre-resolve allowed roots once — realpath so symlink escapes fail.
  const allowedRoots = (allowedPaths ?? [process.cwd()]).map((p) => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  });

  const validateFilePath = (requested: string): { path: string } | { error: string } => {
    if (!isAbsolute(requested) && !requested.startsWith('~')) {
      // Relative paths resolve against cwd — still must land inside roots.
    }
    const expanded = requested.startsWith('~/')
      ? resolve(process.env.HOME ?? '', requested.slice(2))
      : resolve(requested);
    let real: string;
    try {
      real = realpathSync(expanded);
    } catch {
      return { error: `file not found: ${requested}` };
    }
    let size: number;
    try {
      const st = statSync(real);
      if (!st.isFile()) return { error: `not a regular file: ${requested}` };
      size = st.size;
    } catch {
      return { error: `cannot stat: ${requested}` };
    }
    if (size > maxFileSizeBytes) {
      return {
        error: `file too large (${Math.ceil(size / 1024 / 1024)}MB > ${Math.floor(maxFileSizeBytes / 1024 / 1024)}MB limit)`,
      };
    }
    const inside = allowedRoots.some((root) => real === root || real.startsWith(`${root}${sep}`));
    if (!inside) {
      return { error: `path is outside allowed directories: ${requested}` };
    }
    return { path: real };
  };

  // Human-readable rendering with GMT offset so the agent can confirm
  // schedules to the operator.
  const describe = (j: Job): Job & { firesAtLocal?: string; readOnly: boolean } => ({
    ...j,
    firesAtLocal: j.trigger.kind === 'once' ? formatFiresAt(j.trigger.at, timezone) : undefined,
    readOnly: j.managed !== 'agent',
  });

  /**
   * Resolve the schedule fields of a create/update body into a JobTrigger.
   * Exactly one of: in|at (once), every|expr (cron), manual:true.
   */
  const resolveTrigger = (body: Json): { trigger?: JobTrigger; error?: string } => {
    const inStr = _str(body.in);
    const at = _str(body.at);
    const every = _str(body.every);
    const expr = _str(body.expr);
    const manual = body.manual === true;

    const sources = [inStr, at, every, expr].filter(Boolean).length + (manual ? 1 : 0);
    if (sources !== 1) {
      return {
        error:
          'exactly one schedule source required: "in"/"at" (once), "every"/"expr" (cron), or "manual": true',
      };
    }

    if (manual) return { trigger: { kind: 'manual' } };

    if (inStr || at) {
      if (inStr && at) return { error: 'exactly one of "in" or "at" is required' };
      const input = (inStr ?? at) as string;
      if (!timezone && needsExplicitTimezone(input)) {
        return {
          error: `"${input}" is an absolute time without a zone — set "timezone" in acp-connector.jsonc (e.g. "America/Argentina/Tucuman") or include an explicit offset like -03:00`,
        };
      }
      const ts = parseWhenTime(input, timezone, now());
      if (ts === null) {
        return {
          error: `could not parse "${input}" as a future time`,
        };
      }
      return { trigger: { kind: 'once', at: new Date(ts).toISOString() } };
    }

    if (every) {
      const schedule = everyToCron(every);
      if (!schedule) {
        return { error: `cannot express "${every}" as cron — use "expr" instead` };
      }
      return { trigger: { kind: 'cron', expr: schedule } };
    }

    return { trigger: { kind: 'cron', expr: expr as string } };
  };

  // Operator-owned jobs are read-only for the agent.
  const agentJob = (id: string) => {
    const job = jobs.get(id);
    if (!job) return { error: `job "${id}" not found`, status: 404 };
    if (job.managed !== 'agent') {
      return {
        error: `job "${id}" is operator-managed and read-only for the agent`,
        status: 400,
      };
    }
    return { job, status: 200 };
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      // -------------------------------------------------------- messaging
      if (path === '/aliases' && req.method === 'GET') {
        _ok(res, { aliases: aliases?.list() ?? [] });
        return;
      }
      if (path === '/file/send' && req.method === 'POST') {
        if (!fileSend) return _err(res, 'file sending is not available on this bridge');
        const body = await _readBody(req);
        const requested = _str(body.path);
        if (!requested) return _err(res, '"path" is required');
        const validated = validateFilePath(requested);
        if ('error' in validated) return _err(res, validated.error);
        const filePath = validated.path;
        const target = fileSend.resolve(_str(body.to));
        if ('error' in target) return _err(res, target.error);
        const caption = _str(body.caption)?.slice(0, CAPTION_MAX);
        try {
          await fileSend.send(target.platform, target.chatId, filePath, caption);
        } catch (err) {
          return _err(res, `send failed: ${(err as Error).message}`, 502);
        }
        log.info(`📎 sent ${filePath} → ${target.alias}`);
        return _ok(res, { deliveredTo: target.alias });
      }

      // ---------------------------------------------------------------- jobs
      if (path === '/jobs/list' && req.method === 'GET') {
        _ok(res, { jobs: jobs.list().map(describe), now: new Date(now()).toISOString() });
        return;
      }
      if (path === '/jobs/create' && req.method === 'POST') {
        const body = await _readBody(req);
        const prompt = _str(body.prompt);
        if (!prompt) return _err(res, '"prompt" is required');
        const { trigger, error } = resolveTrigger(body);
        if (!trigger) return _err(res, error ?? 'invalid trigger');
        try {
          const job = jobs.create({
            prompt,
            trigger,
            name: _str(body.name),
            managed: 'agent',
          });
          return _ok(res, { job: describe(job) });
        } catch (err) {
          return _err(res, (err as Error).message, 400);
        }
      }
      if (path === '/jobs/update' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentJob(id);
        if (!job) return _err(res, error ?? 'not found', status);
        const patch: { prompt?: string; name?: string; enabled?: boolean; trigger?: JobTrigger } =
          {};
        const prompt = _str(body.prompt);
        if (prompt) patch.prompt = prompt;
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        const hasSchedule =
          _str(body.in) ||
          _str(body.at) ||
          _str(body.every) ||
          _str(body.expr) ||
          body.manual === true;
        if (hasSchedule) {
          const { trigger, error: tErr } = resolveTrigger(body);
          if (!trigger) return _err(res, tErr ?? 'invalid trigger');
          patch.trigger = trigger;
        }
        if (
          !patch.prompt &&
          patch.name === undefined &&
          patch.enabled === undefined &&
          !patch.trigger
        ) {
          return _err(res, 'nothing to update');
        }
        try {
          const updated = jobs.update(job.id, patch);
          if (!updated) return _err(res, `job "${id}" not found`, 404);
          return _ok(res, { job: describe(updated) });
        } catch (err) {
          return _err(res, (err as Error).message, 400);
        }
      }
      if (path === '/jobs/delete' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentJob(id);
        if (!job) return _err(res, error ?? 'not found', status);
        jobs.remove(job.id);
        return _ok(res);
      }
      if (path === '/jobs/run' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentJob(id);
        if (!job) return _err(res, error ?? 'not found', status);
        jobs.run(job.id);
        return _ok(res);
      }
      if (path === '/jobs/toggle' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentJob(id);
        if (!job) return _err(res, error ?? 'not found', status);
        const enabled = jobs.toggle(job.id);
        return _ok(res, { enabled });
      }

      _err(res, `not found: ${req.method} ${path}`, 404);
    } catch (err) {
      if ((err as Error).message === 'body too large') {
        return _err(res, 'body too large', 413);
      }
      log.error(`bridge-api route failed: ${(err as Error).message}`);
      _err(res, 'internal error', 500);
    }
  };
}

/**
 * Start the loopback API. Returns the server and the port it bound to
 * (port 0 = ephemeral; read the real port from the returned value).
 */
export async function startBridgeApi(
  opts: BridgeApiOptions & { host?: string; port?: number }
): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const handler = createBridgeApiHandler(opts);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error(`bridge-api: ${(err as Error).message}`);
      _err(res, 'internal error', 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  log.info(`🌉 bridge api listening on http://${host}:${bound}`);
  return { server, port: bound };
}
