import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REMINDERS,
  parseReminderTime,
  ReminderManager,
  type ReminderManagerOptions,
} from '../src/reminders.ts';

let dir: string;
let storePath: string;
let nowMs: number;

function createManager(overrides: Partial<ReminderManagerOptions> = {}) {
  const deliver = vi.fn();
  const onLog = vi.fn();
  let deliverable = true;
  const manager = new ReminderManager({
    storePath,
    canDeliver: () => deliverable,
    deliver,
    onLog,
    now: () => nowMs,
    ...overrides,
  });
  return {
    manager,
    deliver,
    onLog,
    setDeliverable: (v: boolean) => {
      deliverable = v;
    },
  };
}

function stored() {
  return JSON.parse(readFileSync(storePath, 'utf8')) as Array<{ id: string }>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-rem-'));
  storePath = join(dir, 'reminders.json');
  nowMs = Date.parse('2026-03-01T12:00:00Z');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ReminderManager', () => {
  it('persists created reminders to the store file', () => {
    const { manager } = createManager();
    manager.create('check reply', nowMs + 60_000);
    expect(stored()).toHaveLength(1);
    expect(stored()[0].id).toMatch(/^[a-z0-9]{8}$/);
    expect(manager.list()[0].firesAt).toBe(new Date(nowMs + 60_000).toISOString());
  });

  it('rejects reminders in the past and above the cap', () => {
    const { manager } = createManager();
    expect(() => manager.create('past', nowMs - 1)).toThrow('future');
    for (let i = 0; i < MAX_REMINDERS; i++) {
      manager.create(`r${i}`, nowMs + i + 1000);
    }
    expect(() => manager.create('one more', nowMs + 999_999)).toThrow('limit');
  });

  it('delivers due reminders as [Reminder <id>] <prompt> and deletes them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const { manager, deliver } = createManager({ now: () => Date.now() });
      const r = manager.create('ping', nowMs + 1000);
      manager.start();
      vi.advanceTimersByTime(1500);
      expect(deliver).toHaveBeenCalledWith(`[Reminder ${r.id}] ping`);
      expect(stored()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers past-due reminders on start (boot flush), oldest first', () => {
    const { manager, deliver } = createManager();
    writeFileSync(
      storePath,
      JSON.stringify([
        { id: 'newer', prompt: 'b', firesAt: new Date(nowMs - 1000).toISOString(), createdAt: '' },
        { id: 'older', prompt: 'a', firesAt: new Date(nowMs - 5000).toISOString(), createdAt: '' },
      ])
    );
    manager.start();
    manager.stop();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([
      '[Reminder older] a',
      '[Reminder newer] b',
    ]);
    expect(stored()).toHaveLength(0);
  });

  it('keeps undeliverable due reminders and retries on the next flush', () => {
    const { manager, deliver, setDeliverable } = createManager();
    writeFileSync(
      storePath,
      JSON.stringify([
        {
          id: 'wait',
          prompt: 'later',
          firesAt: new Date(nowMs - 1000).toISOString(),
          createdAt: '',
        },
      ])
    );
    setDeliverable(false);
    manager.start();
    expect(deliver).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
    // Agent connects later — retry delivers and deletes.
    setDeliverable(true);
    manager.flushDue();
    manager.stop();
    expect(deliver).toHaveBeenCalledWith('[Reminder wait] later');
    expect(stored()).toHaveLength(0);
  });

  it('discards entries older than 7 days past firesAt on start', () => {
    const { manager, deliver } = createManager();
    writeFileSync(
      storePath,
      JSON.stringify([
        {
          id: 'stale',
          prompt: 'old',
          firesAt: new Date(nowMs - 8 * 24 * 3600 * 1000).toISOString(),
          createdAt: '',
        },
        {
          id: 'fresh',
          prompt: 'new',
          firesAt: new Date(nowMs + 60_000).toISOString(),
          createdAt: '',
        },
      ])
    );
    manager.start();
    manager.stop();
    expect(deliver).not.toHaveBeenCalled();
    expect(manager.list().map((r) => r.id)).toEqual(['fresh']);
    expect(stored()).toHaveLength(1);
  });

  it('restarts with persisted reminders and re-schedules them', () => {
    const first = createManager();
    const r = first.manager.create('survive', nowMs + 60_000);
    first.manager.stop();

    const second = createManager();
    second.manager.start();
    expect(second.manager.list().map((x) => x.id)).toEqual([r.id]);
    second.manager.stop();
  });

  it('cancels reminders by id and reschedules via update', () => {
    const { manager } = createManager();
    const a = manager.create('a', nowMs + 1000);
    const b = manager.create('b', nowMs + 2000);
    expect(manager.cancel(a.id)).toBe(true);
    expect(manager.cancel('nope')).toBe(false);
    const updated = manager.update(b.id, { firesAt: nowMs + 9000, prompt: 'b2' });
    expect(updated?.prompt).toBe('b2');
    expect(updated?.firesAt).toBe(new Date(nowMs + 9000).toISOString());
    expect(manager.update('nope', {})).toBeNull();
    expect(manager.list()).toHaveLength(1);
  });
});

describe('parseReminderTime', () => {
  const now = Date.parse('2026-03-01T12:00:00Z'); // Sunday 12:00 UTC

  it('parses duration shorthands relative to now', () => {
    expect(parseReminderTime('30m', 'in', 'UTC', now)).toBe(now + 30 * 60_000);
    expect(parseReminderTime('2h', 'in', 'UTC', now)).toBe(now + 2 * 3600_000);
    expect(parseReminderTime('1 day', 'in', 'UTC', now)).toBe(now + 86_400_000);
  });

  it('parses chrono relative strings', () => {
    expect(parseReminderTime('2 hours', 'in', 'UTC', now)).toBe(now + 2 * 3600_000);
    expect(parseReminderTime('in 45 minutes', 'in', 'UTC', now)).toBe(now + 45 * 60_000);
  });

  it('rejects unparseable or non-future "in" values', () => {
    expect(parseReminderTime('banana', 'in', 'UTC', now)).toBeNull();
    expect(parseReminderTime('yesterday', 'in', 'UTC', now)).toBeNull();
  });

  it('parses explicit-zone ISO datetimes as absolute', () => {
    const ts = parseReminderTime('2026-03-01T15:00:00Z', 'at', 'UTC', now);
    expect(ts).toBe(Date.parse('2026-03-01T15:00:00Z'));
    const off = parseReminderTime('2026-03-01T12:00:00-03:00', 'at', 'UTC', now);
    expect(off).toBe(Date.parse('2026-03-01T15:00:00Z'));
  });

  it('parses naive wall times in the given timezone', () => {
    // 15:00 in UTC on 2026-03-02
    const utc = parseReminderTime('2026-03-02 15:00', 'at', 'UTC', now);
    expect(utc).toBe(Date.parse('2026-03-02T15:00:00Z'));
    // Same wall time in America/Argentina/Tucuman (UTC-3) → 18:00 UTC
    const tuc = parseReminderTime('2026-03-02 15:00', 'at', 'America/Argentina/Tucuman', now);
    expect(tuc).toBe(Date.parse('2026-03-02T18:00:00Z'));
  });

  it('resolves "tomorrow" against the operator timezone', () => {
    // In Tucuman (UTC-3), 2026-03-01 12:00 UTC is 09:00 — tomorrow 10:00
    // local is 2026-03-02 10:00 -03:00 = 13:00 UTC.
    const ts = parseReminderTime('tomorrow 10am', 'at', 'America/Argentina/Tucuman', now);
    expect(ts).toBe(Date.parse('2026-03-02T13:00:00Z'));
  });
});
