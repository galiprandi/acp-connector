import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBridgeApi } from '../src/bridge-api.js';
import { JobManager, MAX_AGENT_JOBS } from '../src/jobs.js';
import { StateStore } from '../src/state.js';

type MockFn = ReturnType<typeof vi.fn>;

let dir: string;
let statePath: string;
let store: StateStore;
let baseUrl: string;
let close: () => void;
let jobs: JobManager;
let enqueue: MockFn;

async function api(path: string, body?: Record<string, unknown>, method?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acp-bapi-'));
  statePath = join(dir, 'state.json');
  store = StateStore.load(statePath);
  enqueue = vi.fn();
  jobs = new JobManager({
    store,
    allowedChatIds: [1],
    enqueue,
    sendMessage: vi.fn(async () => {}),
    timezone: 'UTC',
  });
  // Seed one operator job (read-only for the agent) and one agent job.
  jobs.create({
    prompt: 'operator owned',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    name: 'op-job',
    managed: 'operator',
  });
  jobs.create({
    prompt: 'agent owned',
    trigger: { kind: 'cron', expr: '0 8 * * *' },
    name: 'agent-old',
    managed: 'agent',
  });
  const { server, port } = await startBridgeApi({ jobs, timezone: 'UTC' });
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => server.close();
});

afterEach(() => {
  close();
  jobs.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('jobs api — create', () => {
  it('creates once jobs from "in" and "at"', async () => {
    const a = await api('/jobs/create', { prompt: 'check reply', in: '30m' });
    expect(a.json.ok).toBe(true);
    const job = a.json.job as { trigger: { kind: string; at?: string }; managed: string };
    expect(job.trigger.kind).toBe('once');
    expect(Date.parse(job.trigger.at ?? '')).toBeGreaterThan(Date.now());
    expect(job.managed).toBe('agent');

    const b = await api('/jobs/create', { prompt: 'x', at: '2030-01-01T10:00:00Z' });
    expect(b.json.ok).toBe(true);
  });

  it('rejects ambiguous or missing schedule sources', async () => {
    expect((await api('/jobs/create', { prompt: 'x' })).json.ok).toBe(false);
    expect((await api('/jobs/create', { prompt: 'x', in: '1h', at: 'tomorrow' })).json.ok).toBe(
      false
    );
    expect(
      (await api('/jobs/create', { prompt: 'x', every: '1h', expr: '* * * * *' })).json.ok
    ).toBe(false);
    expect((await api('/jobs/create', { prompt: 'x', every: '1h', manual: true })).json.ok).toBe(
      false
    );
  });

  it('creates cron jobs from "every" and "expr"', async () => {
    const a = await api('/jobs/create', { every: '30m', prompt: 'tick' });
    expect(a.json.ok).toBe(true);
    expect((a.json.job as { trigger: { expr: string } }).trigger.expr).toBe('*/30 * * * *');

    const b = await api('/jobs/create', { expr: '0 7 * * 1-5', prompt: 'weekdays' });
    expect(b.json.ok).toBe(true);

    expect((await api('/jobs/create', { every: '45m', prompt: 'x' })).json.ok).toBe(false);
    expect((await api('/jobs/create', { expr: 'bad', prompt: 'x' })).json.ok).toBe(false);
  });

  it('creates manual jobs that require a name', async () => {
    const ok = await api('/jobs/create', {
      prompt: 'run deploy checklist',
      manual: true,
      name: 'deploy',
    });
    expect(ok.json.ok).toBe(true);
    const bad = await api('/jobs/create', { prompt: 'x', manual: true });
    expect(bad.json.ok).toBe(false);
  });

  it('rejects naive absolute times when timezone is not configured', async () => {
    const { server, port } = await startBridgeApi({ jobs });
    const url = `http://127.0.0.1:${port}`;
    const post = (body: Record<string, unknown>) =>
      fetch(`${url}/jobs/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({
        status: r.status,
        json: (await r.json()) as Record<string, unknown>,
      }));
    try {
      const naive = await post({ prompt: 'x', at: 'tomorrow 10am' });
      expect(naive.json.ok).toBe(false);
      expect(String(naive.json.error)).toContain('timezone');
      // durations and explicit zones never need a configured timezone
      expect((await post({ prompt: 'x', in: '30m' })).json.ok).toBe(true);
      expect((await post({ prompt: 'x', at: '2030-01-01T10:00:00Z' })).json.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns firesAtLocal and now in responses', async () => {
    const { json } = await api('/jobs/create', { prompt: 'x', in: '1h' });
    const job = json.job as { firesAtLocal?: string };
    expect(job.firesAtLocal).toContain('GMT');
    const list = await api('/jobs/list');
    expect(list.json.now).toBeTruthy();
    const items = list.json.jobs as Array<{ firesAtLocal?: string }>;
    expect(items.some((j) => j.firesAtLocal?.includes('GMT'))).toBe(true);
  });
});

describe('jobs api — list/update/delete/run/toggle', () => {
  it('lists all jobs flagging operator-owned ones read-only', async () => {
    const { json } = await api('/jobs/list');
    const list = json.jobs as Array<{
      id: string;
      name?: string;
      managed: string;
      readOnly: boolean;
    }>;
    const op = list.find((j) => j.name === 'op-job');
    const agent = list.find((j) => j.name === 'agent-old');
    expect(op?.managed).toBe('operator');
    expect(op?.readOnly).toBe(true);
    expect(agent?.managed).toBe('agent');
    expect(agent?.readOnly).toBe(false);
  });

  it('keeps operator jobs read-only for the agent', async () => {
    expect((await api('/jobs/update', { id: 'op-job', every: '1h' })).status).toBe(400);
    expect((await api('/jobs/delete', { id: 'op-job' })).status).toBe(400);
    expect((await api('/jobs/run', { id: 'op-job' })).status).toBe(400);
    expect((await api('/jobs/toggle', { id: 'op-job' })).status).toBe(400);
  });

  it('updates and deletes only agent-managed jobs', async () => {
    const upd = await api('/jobs/update', { id: 'agent-old', every: '2h', enabled: false });
    expect(upd.json.ok).toBe(true);
    const job = upd.json.job as { trigger: { expr: string }; enabled: boolean };
    expect(job.trigger.expr).toBe('0 */2 * * *');
    expect(job.enabled).toBe(false);

    // prompt-only update keeps the trigger
    const upd2 = await api('/jobs/update', { id: 'agent-old', prompt: 'new prompt' });
    expect((upd2.json.job as { prompt: string }).prompt).toBe('new prompt');

    expect((await api('/jobs/delete', { id: 'agent-old' })).json.ok).toBe(true);
    expect((await api('/jobs/delete', { id: 'agent-old' })).status).toBe(404);
    expect((await api('/jobs/update', { id: 'nope', prompt: 'x' })).status).toBe(404);
  });

  it('run delivers the prompt and toggle flips enabled', async () => {
    const created = await api('/jobs/create', {
      prompt: 'fire me',
      manual: true,
      name: 'manual-job',
    });
    const id = (created.json.job as { id: string }).id;

    expect((await api('/jobs/run', { id })).json.ok).toBe(true);
    // agent job fires as remote content with the [Agent job …] prefix
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('[Agent job manual-job]'),
      1,
      'agent-job'
    );

    const tog = await api('/jobs/toggle', { id });
    expect(tog.json.enabled).toBe(false);
  });

  it('caps agent-created jobs', async () => {
    for (let i = 0; i < MAX_AGENT_JOBS - 1; i++) {
      jobs.create({
        prompt: `fill ${i}`,
        trigger: { kind: 'manual' },
        name: `fill-${i}`,
        managed: 'agent',
      });
    }
    const full = await api('/jobs/create', { every: '1h', prompt: 'one too many' });
    expect(full.status).toBe(400);
    expect(String(full.json.error)).toContain('cap reached');

    jobs.remove('agent-old'); // free a slot
    const ok = await api('/jobs/create', { every: '1h', prompt: 'fits now' });
    expect(ok.json.ok).toBe(true);
  });
});

describe('messaging api', () => {
  async function startMessagingApi(overrides: Record<string, unknown> = {}) {
    const { AliasDirectory } = await import('../src/aliases.js');
    const aliases = new AliasDirectory(store);
    aliases.register('telegram', 123, { name: 'Germán Aliprandi', isGroup: false });
    aliases.register('telegram', -100, {
      name: 'Santi',
      isGroup: true,
      chatName: 'Familia',
    });
    const send = vi.fn(async () => {});
    const resolveFn = vi.fn((to?: string) => {
      if (!to) return { platform: 'telegram', chatId: 123, alias: 'current chat' };
      const r = aliases.resolve(to);
      return r.ok
        ? { platform: r.entry.platform, chatId: r.entry.chatId, alias: r.entry.alias }
        : { error: r.error };
    });
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'quarterly report');
    const { server, port } = await startBridgeApi({
      jobs,
      aliases,
      allowedPaths: [dir],
      fileSend: { resolve: resolveFn, send },
      ...overrides,
    });
    return {
      url: `http://127.0.0.1:${port}`,
      server,
      aliases,
      send,
      resolveFn,
      file,
    };
  }

  it('GET /aliases lists aliases without raw chat ids', async () => {
    const { url, server } = await startMessagingApi();
    try {
      const res = await fetch(`${url}/aliases`);
      const json = (await res.json()) as { aliases: Array<Record<string, unknown>> };
      expect(json.aliases.map((a) => a.alias)).toEqual([
        'Telegram/Familia',
        'Telegram/Germán Aliprandi',
      ]);
      expect(json.aliases[0]).not.toHaveProperty('chatId');
    } finally {
      server.close();
    }
  });

  it('POST /file/send defaults to the current chat and delivers the file', async () => {
    const { url, server, send, file } = await startMessagingApi();
    try {
      const res = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, caption: 'here you go' }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveredTo).toBe('current chat');
      expect(send).toHaveBeenCalledWith('telegram', 123, expect.any(String), 'here you go');
    } finally {
      server.close();
    }
  });

  it('POST /file/send resolves an explicit alias to its chat', async () => {
    const { url, server, send, file } = await startMessagingApi();
    try {
      const res = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, to: 'Telegram/Familia' }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.deliveredTo).toBe('Telegram/Familia');
      expect(send).toHaveBeenCalledWith('telegram', '-100', expect.any(String), undefined);
    } finally {
      server.close();
    }
  });

  it('POST /file/send rejects unknown aliases and paths outside allowed dirs', async () => {
    const { url, server, send, file } = await startMessagingApi();
    try {
      const badAlias = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, to: 'Telegram/Nadie' }),
      });
      expect(((await badAlias.json()) as { ok: boolean }).ok).toBe(false);

      const outside = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/etc/hostname' }),
      });
      const outsideJson = (await outside.json()) as { ok: boolean; error: string };
      expect(outsideJson.ok).toBe(false);
      expect(outsideJson.error).toContain('outside allowed');

      const missing = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: join(dir, 'nope.bin') }),
      });
      expect(((await missing.json()) as { ok: boolean }).ok).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('POST /file/send rejects files over the size cap', async () => {
    const { url, server, send, file } = await startMessagingApi({ maxFileSizeBytes: 4 });
    try {
      const res = await fetch(`${url}/file/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      });
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('too large');
      expect(send).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
