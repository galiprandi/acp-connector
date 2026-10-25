import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '../src/cron';

const mockTask: { stop: vi.Mock } = { stop: vi.fn() };
const mockValidate: vi.Mock = vi.fn(() => true);
const mockSchedule: vi.Mock = vi.fn(() => mockTask);

vi.mock('node-cron', () => ({
  default: {
    validate: mockValidate,
    schedule: mockSchedule,
  },
}));

const savedCron: CronJob[][] = [];
vi.mock('../src/config.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.ts')>();
  return {
    ...mod,
    loadConfig: () => ({ agentCmd: 'x', cron: [] }),
    saveConfig: (config: { cron?: CronJob[] }) => {
      savedCron.push(config.cron ?? []);
    },
  };
});

const { CronManager } = await import('../src/cron.ts');
const { ReminderManager } = await import('../src/reminders.ts');
const { startRemindersApi } = await import('../src/reminders-api.ts');

let dir: string;
let baseUrl: string;
let close: () => void;
let reminders: InstanceType<typeof ReminderManager>;
let cronManager: InstanceType<typeof CronManager>;

async function api(path: string, body?: Record<string, unknown>, method?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  savedCron.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'acp-rapi-'));
  reminders = new ReminderManager({
    storePath: join(dir, 'reminders.json'),
    canDeliver: () => false,
    deliver: vi.fn(),
    onLog: () => {},
  });
  cronManager = new CronManager({
    jobs: [
      { name: 'op-job', schedule: '0 9 * * *', prompt: 'operator owned' },
      { name: 'agent-old', schedule: '0 8 * * *', prompt: 'agent owned', managed: 'agent' },
    ],
    allowedChatIds: [1],
    enqueue: vi.fn(),
    onLog: () => {},
  });
  const { server, port } = await startRemindersApi({
    reminders,
    cronManager,
    timezone: 'UTC',
  });
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => server.close();
});

afterEach(() => {
  close();
  reminders.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('reminders api', () => {
  it('creates a reminder with "in" and returns id + firesAt', async () => {
    const { json } = await api('/reminder/create', { prompt: 'check reply', in: '30m' });
    expect(json.ok).toBe(true);
    const r = json.reminder as { id: string; firesAt: string };
    expect(r.id).toBeTruthy();
    expect(Date.parse(r.firesAt)).toBeGreaterThan(Date.now());
  });

  it('creates a reminder with "at" and rejects both in+at', async () => {
    const ok = await api('/reminder/create', {
      prompt: 'x',
      at: '2030-01-01T10:00:00Z',
    });
    expect(ok.json.ok).toBe(true);
    const bad = await api('/reminder/create', { prompt: 'x', in: '1h', at: 'tomorrow' });
    expect(bad.json.ok).toBe(false);
    const missing = await api('/reminder/create', { prompt: 'x' });
    expect(missing.json.ok).toBe(false);
  });

  it('lists, updates and cancels reminders', async () => {
    const created = await api('/reminder/create', { prompt: 'a', in: '1h' });
    const id = (created.json.reminder as { id: string }).id;

    const list = await api('/reminder/list');
    expect((list.json.reminders as unknown[]).length).toBe(1);

    const updated = await api('/reminder/update', { id, in: '2h', prompt: 'b' });
    const r = updated.json.reminder as { prompt: string; firesAt: string };
    expect(r.prompt).toBe('b');

    expect((await api('/reminder/cancel', { id })).json.ok).toBe(true);
    expect((await api('/reminder/cancel', { id })).status).toBe(404);
    expect((await api('/reminder/update', { id: 'nope', in: '1h' })).status).toBe(404);
  });
});

describe('cron api', () => {
  it('creates agent-managed jobs from "every" and "expr"', async () => {
    const a = await api('/cron/create', { every: '30m', prompt: 'tick' });
    expect(a.json.ok).toBe(true);
    expect((a.json.cron as { schedule: string }).schedule).toBe('*/30 * * * *');

    const b = await api('/cron/create', { expr: '0 7 * * 1-5', prompt: 'weekdays' });
    expect(b.json.ok).toBe(true);

    // persisted as managed: "agent" (inspect the latest save)
    const last = savedCron.at(-1) ?? [];
    expect(last.filter((j) => j.managed === 'agent').length).toBe(3);
    expect(last.find((j) => j.name === 'op-job')?.managed).toBeUndefined();
  });

  it('rejects unsupported intervals and missing schedule', async () => {
    expect((await api('/cron/create', { every: '45m', prompt: 'x' })).json.ok).toBe(false);
    expect((await api('/cron/create', { prompt: 'x' })).json.ok).toBe(false);
    expect(
      (await api('/cron/create', { every: '1h', expr: '* * * * *', prompt: 'x' })).json.ok
    ).toBe(false);
  });

  it('lists all jobs flagging operator-owned ones read-only', async () => {
    const { json } = await api('/cron/list');
    const jobs = json.crons as Array<{ id: string; managed: string; readOnly: boolean }>;
    const op = jobs.find((j) => j.id === 'op-job');
    const agent = jobs.find((j) => j.id === 'agent-old');
    expect(op?.managed).toBe('operator');
    expect(op?.readOnly).toBe(true);
    expect(agent?.managed).toBe('agent');
    expect(agent?.readOnly).toBe(false);
  });

  it('updates and deletes only agent-managed jobs', async () => {
    // operator job is read-only
    expect((await api('/cron/update', { id: 'op-job', every: '1h' })).status).toBe(400);
    expect((await api('/cron/delete', { id: 'op-job' })).status).toBe(400);

    const upd = await api('/cron/update', { id: 'agent-old', every: '2h', enabled: false });
    expect(upd.json.ok).toBe(true);
    const cron = upd.json.cron as { schedule: string; enabled: boolean };
    expect(cron.schedule).toBe('0 */2 * * *');
    expect(cron.enabled).toBe(false);

    expect((await api('/cron/delete', { id: 'agent-old' })).json.ok).toBe(true);
    expect((await api('/cron/delete', { id: 'agent-old' })).status).toBe(404);
  });
});
