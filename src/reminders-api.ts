import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CronManager } from './cron.js';
import { everyToCron } from './cron.js';
import { log } from './logger.js';
import type { ReminderManager } from './reminders.js';
import { parseReminderTime } from './reminders.js';
import { persistCronAndRoutines } from './routines.js';

/**
 * Loopback HTTP API backing the `reminders-mcp` stdio server. The MCP
 * server runs inside the agent process; this API is how its tools reach
 * the bridge's reminder store, cron manager and prompt queue.
 *
 * Bound to 127.0.0.1 on an ephemeral port, no auth — same trust model
 * as the A2A loopback endpoints (the agent is already fully trusted).
 */

const MAX_BODY = 64 * 1024;

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
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function _str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export interface RemindersApiOptions {
  reminders: ReminderManager;
  cronManager: CronManager;
  /** IANA timezone for `at` parsing (default: system timezone). */
  timezone: string;
}

/**
 * Shared handler — exported for tests so tools can be exercised without
 * spawning the MCP server.
 */
export function createRemindersApiHandler({
  reminders,
  cronManager,
  timezone,
}: RemindersApiOptions) {
  const now = () => Date.now();

  const parseFire = (body: Json): { ts: number | null; error?: string } => {
    const input = _str(body.in) ?? _str(body.at);
    if (_str(body.in) && _str(body.at)) {
      return { ts: null, error: 'exactly one of "in" or "at" is required' };
    }
    if (!input) return { ts: null, error: 'exactly one of "in" or "at" is required' };
    const mode = _str(body.in) ? 'in' : 'at';
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
      // ---------------------------------------------------------- reminders
      if (path === '/reminder/list' && req.method === 'GET') {
        _ok(res, { reminders: reminders.list() });
        return;
      }
      if (path === '/reminder/create' && req.method === 'POST') {
        const body = await _readBody(req);
        const prompt = _str(body.prompt);
        if (!prompt) return _err(res, '"prompt" is required');
        const { ts, error } = parseFire(body);
        if (ts === null) return _err(res, error ?? 'invalid time');
        const r = reminders.create(prompt, ts);
        return _ok(res, { reminder: r });
      }
      if (path === '/reminder/cancel' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
        if (!reminders.cancel(id)) return _err(res, `reminder "${id}" not found`, 404);
        return _ok(res);
      }
      if (path === '/reminder/update' && req.method === 'POST') {
        const body = await _readBody(req);
        const id = _str(body.id);
        if (!id) return _err(res, '"id" is required');
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
        return _ok(res, { reminder: r });
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
      _err(res, (err as Error).message, 500);
    }
  };
}

/**
 * Start the loopback API. Returns the server and the port it bound to
 * (port 0 = ephemeral; read the real port from the returned value).
 */
export async function startRemindersApi(
  opts: RemindersApiOptions & { host?: string; port?: number }
): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const handler = createRemindersApiHandler(opts);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error(`reminders-api: ${(err as Error).message}`);
      _err(res, 'internal error', 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  log.info(`⏰ reminders api listening on http://${host}:${bound}`);
  return { server, port: bound };
}
