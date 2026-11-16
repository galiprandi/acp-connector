import { realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, resolve, sep } from 'node:path';
import type { AliasDirectory } from './aliases.js';
import type { CronManager } from './cron.js';
import { everyToCron } from './cron.js';
import { log } from './logger.js';
import type { Reminder, ReminderManager } from './reminders.js';
import { formatFiresAt, needsExplicitTimezone, parseReminderTime } from './reminders.js';
import { persistCronAndRoutines } from './routines.js';

/**
 * Loopback HTTP API backing the `acp-tools` MCP stdio server. The MCP
 * server runs inside the agent process; this API is how its tools reach
 * the bridge's reminder store, cron manager, chat alias directory and
 * messaging transports.
 *
 * Bound to 127.0.0.1 on an ephemeral port, no auth — same trust model
 * as the A2A loopback endpoints (the agent is already fully trusted).
 */

const MAX_BODY = 64 * 1024;
/** Default cap for agent-sent files — Telegram bot uploads max ~50MB. */
export const DEFAULT_MAX_FILE_BYTES = 45 * 1024 * 1024;
const CAPTION_MAX = 1024;

/**
 * Maximum number of concurrently persisted agent-created cron jobs.
 * Mirrors MAX_REMINDERS in reminders.ts — bounds restart-surviving
 * resource use if an agent misbehaves. Operator jobs are not capped here.
 */
export const AGENT_CRON_CAP = 50;

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
  reminders: ReminderManager;
  cronManager: CronManager;
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
  reminders,
  cronManager,
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

  // Attach a human-readable local rendering (with GMT offset) so the agent
  // can confirm "alarm set for <time> (<zone>)" to the operator.
  const withLocal = (r: Reminder): Reminder & { firesAtLocal: string } => ({
    ...r,
    firesAtLocal: formatFiresAt(r.firesAt, timezone),
  });

  const parseFire = (body: Json): { ts: number | null; error?: string } => {
    const input = _str(body.in) ?? _str(body.at);
    if (_str(body.in) && _str(body.at)) {
      return { ts: null, error: 'exactly one of "in" or "at" is required' };
    }
    if (!input) return { ts: null, error: 'exactly one of "in" or "at" is required' };
    const mode = _str(body.in) ? 'in' : 'at';
    if (!timezone && needsExplicitTimezone(input, mode)) {
      return {
        ts: null,
        error: `"${input}" is an absolute time without a zone — set "timezone" in acp-connector.jsonc (e.g. "America/Argentina/Tucuman") or include an explicit offset like -03:00`,
      };
    }
    const ts = parseReminderTime(input, mode, timezone, now());
    if (ts === null) {
      return {
        ts: null,
        error: `could not parse "${input}" as a future ${mode === 'in' ? 'delay' : 'time'}`,
      };
    }
    return { ts };
  };

  const cronResolve = (body: Json): { schedule?: string; error?: string } => {
    const expr = _str(body.expr);
    const every = _str(body.every);
    if (expr && every) return { error: 'exactly one of "every" or "expr" is required' };
    if (expr) return { schedule: expr };
    if (every) {
      const schedule = everyToCron(every);
      if (!schedule) {
        return { error: `cannot express "${every}" as cron — use "expr" instead` };
      }
      return { schedule };
    }
    return { error: 'exactly one of "every" or "expr" is required' };
  };

  // Operator-owned reminders are read-only for the agent — same rule as
  // operator cron jobs (agentCron below).
  const agentReminder = (id: string) => {
    const r = reminders.list().find((x) => x.id === id);
    if (!r) return { error: `reminder "${id}" not found`, status: 404 };
    if ((r.managed ?? 'agent') !== 'agent') {
      return {
        error: `reminder "${id}" is operator-managed and read-only for the agent`,
        status: 400,
      };
    }
    return { reminder: r, status: 200 };
  };

  const agentCron = (id: string) => {
    const job = cronManager.list().find((j) => j.name === id);
    if (!job) return { error: `cron job "${id}" not found`, status: 404 };
    if (job.managed !== 'agent') {
      return {
        error: `cron job "${id}" is operator-managed and read-only for the agent`,
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

      // ---------------------------------------------------------- reminders
      if (path === '/reminder/list' && req.method === 'GET') {
        _ok(res, { reminders: reminders.list().map(withLocal) });
        return;
      }
      if (path === '/reminder/create' && req.method === 'POST') {
        const body = await _readBody(req);
        const prompt = _str(body.prompt);
        if (!prompt) return _err(res, '"prompt" is required');
        const { ts, error } = parseFire(body);
        if (ts === null) return _err(res, error ?? 'invalid time');
        const r = reminders.create(prompt, ts, 'agent');
        return _ok(res, { reminder: withLocal(r) });
      }
      if (path === '/reminder/cancel' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { error, status } = agentReminder(id);
        if (error) return _err(res, error, status);
        reminders.cancel(id);
        return _ok(res);
      }
      if (path === '/reminder/update' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { error, status } = agentReminder(id);
        if (error) return _err(res, error, status);
        const patch: { firesAt?: number; prompt?: string } = {};
        if (_str(body.in) || _str(body.at)) {
          const { ts, error } = parseFire(body);
          if (ts === null) return _err(res, error ?? 'invalid time');
          patch.firesAt = ts;
        }
        const prompt = _str(body.prompt);
        if (prompt) patch.prompt = prompt;
        if (patch.firesAt === undefined && !patch.prompt) {
          return _err(res, 'nothing to update: pass "in"/"at" and/or "prompt"');
        }
        const r = reminders.update(id, patch);
        if (!r) return _err(res, `reminder "${id}" not found`, 404);
        return _ok(res, { reminder: withLocal(r) });
      }

      // ---------------------------------------------------------------- cron
      if (path === '/cron/list' && req.method === 'GET') {
        const jobs = cronManager.list().map((j) => ({
          id: j.name,
          schedule: j.schedule,
          prompt: j.prompt,
          enabled: j.enabled !== false,
          managed: j.managed === 'agent' ? 'agent' : 'operator',
          readOnly: j.managed !== 'agent',
        }));
        _ok(res, { crons: jobs });
        return;
      }
      if (path === '/cron/create' && req.method === 'POST') {
        const body = await _readBody(req);
        const prompt = _str(body.prompt);
        if (!prompt) return _err(res, '"prompt" is required');
        const { schedule, error } = cronResolve(body);
        if (!schedule) return _err(res, error ?? 'invalid schedule');
        const agentJobs = cronManager.list().filter((j) => j.managed === 'agent').length;
        if (agentJobs >= AGENT_CRON_CAP) {
          return _err(res, `agent cron job cap reached (${AGENT_CRON_CAP})`);
        }
        const id = `agent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
        const job = cronManager.add({ name: id, schedule, prompt, managed: 'agent' });
        if (!job) return _err(res, 'invalid schedule or duplicate job');
        persistCronAndRoutines(cronManager.list());
        return _ok(res, { cron: { id: job.name, schedule: job.schedule, prompt: job.prompt } });
      }
      if (path === '/cron/update' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentCron(id);
        if (!job) return _err(res, error ?? 'not found', status);
        const patch = { ...job };
        if (_str(body.every) || _str(body.expr)) {
          const { schedule, error: sErr } = cronResolve(body);
          if (!schedule) return _err(res, sErr ?? 'invalid schedule');
          patch.schedule = schedule;
        }
        const prompt = _str(body.prompt);
        if (prompt) patch.prompt = prompt;
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        cronManager.remove(id);
        const added = cronManager.add(patch);
        if (!added) return _err(res, 'invalid schedule — job removed', 500);
        persistCronAndRoutines(cronManager.list());
        return _ok(res, {
          cron: {
            id: added.name,
            schedule: added.schedule,
            prompt: added.prompt,
            enabled: added.enabled !== false,
          },
        });
      }
      if (path === '/cron/delete' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        const { job, error, status } = agentCron(id);
        if (!job) return _err(res, error ?? 'not found', status);
        cronManager.remove(id);
        persistCronAndRoutines(cronManager.list());
        return _ok(res);
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
