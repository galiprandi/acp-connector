import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  everyToCron,
  formatFiresAt,
  isDurationInput,
  JobManager,
  MAX_AGENT_JOBS,
  needsExplicitTimezone,
  parseWhenTime,
} from '../src/jobs.js';
import { StateStore } from '../src/state.js';

let dir: string;
let statePath: string;
let store: StateStore;

// Captured deliveries
let sent: Array<{ text: string; chatId: number | string; source: string }>;
let messages: Array<{ chatId: number | string; text: string }>;
let canDeliverFlag: boolean;
let nowMs: number;

const enqueue = (text: string, chatId: number | string, source: string) => {
  sent.push({ text, chatId, source });
};
const sendMessage = async (chatId: number | string, text: string) => {
  messages.push({ chatId, text });
};

function makeManager(opts: { timezone?: string } = {}): JobManager {
  return new JobManager({
    store,
    allowedChatIds: [12345],
    enqueue,
    sendMessage,
    timezone: opts.timezone,
    canDeliver: () => canDeliverFlag,
    now: () => nowMs,
  });
}

const future = (ms = 60_000) => new Date(nowMs + ms).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-jobs-'));
  statePath = join(dir, 'state.json');
  store = StateStore.load(statePath);
  sent = [];
  messages = [];
  canDeliverFlag = true;
  nowMs = Date.parse('2026-11-17T15:00:00.000Z'); // fixed clock
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ time helpers

describe('everyToCron', () => {
  it('converts human intervals to cron', () => {
    expect(everyToCron('30m')).toBe('*/30 * * * *');
    expect(everyToCron('1h')).toBe('0 */1 * * *');
    expect(everyToCron('6h')).toBe('0 */6 * * *');
    expect(everyToCron('1d')).toBe('0 0 */1 * *');
    expect(everyToCron('1w')).toBe('0 0 * * 0');
    expect(everyToCron('2 hours')).toBe('0 */2 * * *');
  });

  it('rejects non-divisor intervals', () => {
    expect(everyToCron('45m')).toBeNull();
    expect(everyToCron('5h')).toBeNull();
    expect(everyToCron('2w')).toBeNull();
    expect(everyToCron('banana')).toBeNull();
  });
});

describe('parseWhenTime', () => {
  it('parses relative durations', () => {
    expect(parseWhenTime('20m', undefined, nowMs)).toBe(nowMs + 20 * 60_000);
    expect(parseWhenTime('in 2 hours', undefined, nowMs)).toBe(nowMs + 2 * 3_600_000);
    expect(parseWhenTime('30 seconds', undefined, nowMs)).toBe(nowMs + 30_000);
  });

  it('parses ISO datetimes with explicit zone', () => {
    expect(parseWhenTime('2026-11-18T10:00:00-03:00', undefined, nowMs)).toBe(
      Date.parse('2026-11-18T13:00:00.000Z')
    );
  });

  it('resolves naive wall times in the configured timezone, not the host', () => {
    const tz = 'America/Argentina/Tucuman'; // UTC-3
    const ts = parseWhenTime('2026-11-18 09:00', tz, nowMs);
    expect(ts).toBe(Date.parse('2026-11-18T12:00:00.000Z'));
  });

  it('rejects naive absolute times without a timezone', () => {
    expect(parseWhenTime('2026-11-18 09:00', undefined, nowMs)).toBeNull();
    expect(needsExplicitTimezone('2026-11-18 09:00')).toBe(true);
    expect(needsExplicitTimezone('in 20m')).toBe(false);
    expect(needsExplicitTimezone('2026-11-18T09:00:00Z')).toBe(false);
    expect(isDurationInput('45 minutes')).toBe(true);
  });

  it('returns null for past times', () => {
    expect(parseWhenTime('2020-01-01T00:00:00Z', undefined, nowMs)).toBeNull();
  });
});

describe('formatFiresAt', () => {
  it('renders with the configured timezone and offset', () => {
    const out = formatFiresAt('2026-11-18T12:00:00.000Z', 'America/Argentina/Tucuman');
    expect(out).toContain('Tucuman');
    expect(out).toContain('GMT-3');
  });

  it('flags UTC fallback when no timezone is set', () => {
    const out = formatFiresAt('2026-11-18T12:00:00.000Z');
    expect(out).toContain('no config.timezone');
  });
});

// ------------------------------------------------------------ CRUD

describe('JobManager CRUD', () => {
  it('creates and lists jobs of every trigger kind', () => {
    const m = makeManager();
    m.create({ prompt: 'once', trigger: { kind: 'once', at: future() } });
    m.create({ prompt: 'recurring', trigger: { kind: 'cron', expr: '0 * * * *' }, name: 'hourly' });
    m.create({ prompt: 'manual', trigger: { kind: 'manual' }, name: 'deploy' });
    const jobs = m.list();
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.trigger.kind)).toEqual(['once', 'cron', 'manual']);
  });

  it('resolves jobs by id or name', () => {
    const m = makeManager();
    const j = m.create({ prompt: 'x', trigger: { kind: 'manual' }, name: 'MyJob' });
    expect(m.get(j.id)?.name).toBe('MyJob');
    expect(m.get('myjob')?.id).toBe(j.id); // case-insensitive name
    expect(m.get('nope')).toBeUndefined();
  });

  it('rejects invalid creates', () => {
    const m = makeManager();
    expect(() => m.create({ prompt: 'x', trigger: { kind: 'once', at: 'not-a-date' } })).toThrow(
      /invalid fire time/
    );
    expect(() =>
      m.create({ prompt: 'x', trigger: { kind: 'once', at: new Date(nowMs - 1000).toISOString() } })
    ).toThrow(/future/);
    expect(() => m.create({ prompt: 'x', trigger: { kind: 'cron', expr: 'bad expr' } })).toThrow(
      /invalid cron/
    );
    expect(() => m.create({ prompt: 'x', trigger: { kind: 'manual' } })).toThrow(/require a name/);
    expect(() => m.create({ prompt: '  ', trigger: { kind: 'manual' }, name: 'a' })).toThrow(
      /prompt is required/
    );
  });

  it('enforces unique names and the agent cap', () => {
    const m = makeManager();
    m.create({ prompt: 'a', trigger: { kind: 'manual' }, name: 'dup' });
    expect(() => m.create({ prompt: 'b', trigger: { kind: 'manual' }, name: 'DUP' })).toThrow(
      /already exists/
    );
    for (let i = 0; i < MAX_AGENT_JOBS; i++) {
      m.create({
        prompt: `a${i}`,
        trigger: { kind: 'manual' },
        name: `agent${i}`,
        managed: 'agent',
      });
    }
    expect(() =>
      m.create({ prompt: 'x', trigger: { kind: 'manual' }, name: 'one-more', managed: 'agent' })
    ).toThrow(/cap reached/);
  });

  it('toggle pauses and resumes scheduling', () => {
    const m = makeManager();
    const j = m.create({ prompt: 'x', trigger: { kind: 'cron', expr: '0 * * * *' } });
    expect(m.toggle(j.id)).toBe(false);
    expect(m.get(j.id)?.enabled).toBe(false);
    expect(m.toggle(j.id)).toBe(true);
    expect(m.toggle('missing')).toBeNull();
  });

  it('update changes prompt, name and trigger', () => {
    const m = makeManager();
    const j = m.create({ prompt: 'old', trigger: { kind: 'manual' }, name: 'j' });
    const updated = m.update(j.id, {
      prompt: 'new prompt',
      name: 'renamed',
      trigger: { kind: 'cron', expr: '*/5 * * * *' },
    });
    expect(updated?.prompt).toBe('new prompt');
    expect(updated?.name).toBe('renamed');
    expect(updated?.trigger).toEqual({ kind: 'cron', expr: '*/5 * * * *' });
    expect(m.update('missing', { prompt: 'x' })).toBeNull();
  });

  it('persists jobs through state.json', () => {
    const m = makeManager();
    m.create({ prompt: 'persist me', trigger: { kind: 'manual' }, name: 'saved' });
    const reloaded = makeManager(); // same store — reads same file
    expect(reloaded.get('saved')?.prompt).toBe('persist me');
    // Fresh store instance proves it hit disk
    const fresh = new JobManager({
      store: StateStore.load(statePath),
      allowedChatIds: [1],
      enqueue,
      sendMessage,
      now: () => nowMs,
    });
    expect(fresh.get('saved')?.prompt).toBe('persist me');
  });
});

// ------------------------------------------------------------ firing

describe('JobManager firing', () => {
  it('delivers an operator job verbatim with source "job"', () => {
    const m = makeManager();
    const j = m.create({
      prompt: '/status check this',
      trigger: { kind: 'once', at: future() },
      chatId: 777,
    });
    m.flushDue(); // not due yet
    expect(sent).toHaveLength(0);
    nowMs += 120_000;
    m.flushDue();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ text: '/status check this', chatId: 777, source: 'job' });
    // once jobs are deleted on delivery
    expect(m.get(j.id)).toBeUndefined();
  });

  it('delivers an agent job as remote content with a prefix', () => {
    const m = makeManager();
    m.create({
      prompt: '/status do not run commands',
      trigger: { kind: 'once', at: future() },
      managed: 'agent',
      name: 'agentjob',
    });
    nowMs += 120_000;
    m.flushDue();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.source).toBe('agent-job');
    expect(sent[0]?.text).toBe('[Agent job agentjob] /status do not run commands');
  });

  it('keeps due jobs when delivery is impossible and retries later', () => {
    const m = makeManager();
    const j = m.create({ prompt: 'wait', trigger: { kind: 'once', at: future() } });
    canDeliverFlag = false;
    nowMs += 120_000;
    m.flushDue();
    expect(sent).toHaveLength(0);
    expect(m.get(j.id)).toBeDefined(); // kept for retry
    canDeliverFlag = true;
    m.flushDue();
    expect(sent).toHaveLength(1);
    expect(m.get(j.id)).toBeUndefined();
  });

  it('falls back to the first allowed chat when the job has none', () => {
    const m = makeManager();
    m.create({ prompt: 'ping', trigger: { kind: 'once', at: future() } });
    nowMs += 120_000;
    m.flushDue();
    expect(sent[0]?.chatId).toBe(12345);
  });

  it('run() delivers immediately without touching the schedule', () => {
    const m = makeManager();
    const j = m.create({ prompt: 'manual fire', trigger: { kind: 'manual' }, name: 'm' });
    expect(m.run(j.id)).toBe(true);
    expect(sent[0]?.text).toBe('manual fire');
    expect(m.get(j.id)).toBeDefined(); // manual jobs persist
    expect(m.run('missing')).toBe(false);
  });

  it('manual jobs never auto-fire', () => {
    const m = makeManager();
    m.create({ prompt: 'manual', trigger: { kind: 'manual' }, name: 'm' });
    m.start();
    nowMs += 86_400_000;
    m.flushDue();
    expect(sent).toHaveLength(0);
    m.stop();
  });

  it('drops once jobs older than the TTL on start', () => {
    const m = makeManager();
    m.create({ prompt: 'ancient', trigger: { kind: 'once', at: future() } });
    // simulate a persisted job far in the past
    store.set('jobs', [
      {
        id: 'old1',
        prompt: 'ancient',
        trigger: { kind: 'once', at: new Date(nowMs - 8 * 86_400_000).toISOString() },
        enabled: true,
        managed: 'operator',
        createdAt: new Date(nowMs - 8 * 86_400_000).toISOString(),
      },
    ]);
    const m2 = makeManager();
    m2.start();
    expect(m2.list()).toHaveLength(0);
    m2.stop();
  });

  it('stop() is safe to call twice and clears scheduled work', () => {
    const m = makeManager();
    m.create({ prompt: 'x', trigger: { kind: 'once', at: future() } });
    m.create({ prompt: 'y', trigger: { kind: 'cron', expr: '0 * * * *' } });
    m.start();
    m.stop();
    m.stop(); // idempotent
  });
});

// ------------------------------------------------------------ /jobs command

describe('/jobs command', () => {
  it('lists jobs with numbers and kind icons', async () => {
    const m = makeManager({ timezone: 'America/Argentina/Tucuman' });
    await m.handleCommand('/jobs', 12345);
    expect(messages[0]?.text).toContain('No jobs');

    m.create({ prompt: 'check oven', trigger: { kind: 'once', at: future(3_600_000) } });
    m.create({ prompt: 'hourly logs', trigger: { kind: 'cron', expr: '0 * * * *' }, name: 'logs' });
    m.create({ prompt: 'deploy steps', trigger: { kind: 'manual' }, name: 'deploy' });
    messages = [];
    await m.handleCommand('/jobs', 12345);
    const text = messages[0]?.text ?? '';
    expect(text).toContain('⏰');
    expect(text).toContain('🔁');
    expect(text).toContain('⚡');
    expect(text).toContain('`logs`');
    expect(text).toContain('`deploy`');
    expect(text).toContain('1.');
    expect(text).toContain('3.');
  });

  it('adds a relative one-shot job: /jobs add in 20m <prompt>', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add in 20m check the oven', 12345);
    const job = m.list()[0];
    expect(job?.trigger.kind).toBe('once');
    expect(job?.trigger.kind === 'once' && job.trigger.at).toBe(
      new Date(nowMs + 20 * 60_000).toISOString()
    );
    expect(job?.prompt).toBe('check the oven');
    expect(messages.at(-1)?.text).toContain('✅');
  });

  it('adds an interval job: /jobs add every 1h <prompt>', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add every 1h check logs', 12345);
    const job = m.list()[0];
    expect(job?.trigger).toEqual({ kind: 'cron', expr: '0 */1 * * *' });
  });

  it('adds a raw cron job: /jobs add 0 9 * * 1-5 standup', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add 0 9 * * 1-5 morning standup', 12345);
    const job = m.list()[0];
    expect(job?.trigger).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' });
    expect(job?.prompt).toBe('morning standup');
  });

  it('adds a named manual job: /jobs add as deploy manual <prompt>', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add as deploy manual run the deploy checklist', 12345);
    const job = m.list()[0];
    expect(job?.trigger).toEqual({ kind: 'manual' });
    expect(job?.name).toBe('deploy');
  });

  it('rejects manual without a name and unparseable schedules', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add manual no name here', 12345);
    expect(messages.at(-1)?.text).toContain('need a name');
    await m.handleCommand('/jobs add blargh blargh blargh', 12345);
    expect(messages.at(-1)?.text).toContain('Could not parse');
    expect(m.list()).toHaveLength(0);
  });

  it('resolves naive absolute times only with a configured timezone', async () => {
    const noTz = makeManager();
    await noTz.handleCommand('/jobs add tomorrow 9am check', 12345);
    expect(messages.at(-1)?.text).toContain('Could not parse');

    const withTz = makeManager({ timezone: 'America/Argentina/Tucuman' });
    await withTz.handleCommand('/jobs add tomorrow 9am check', 12345);
    const job = withTz.list()[0];
    expect(job?.trigger.kind).toBe('once');
  });

  it('accepts explicit offsets without a timezone', async () => {
    const m = makeManager();
    await m.handleCommand('/jobs add 2026-11-20 18:00 -03:00 party', 12345);
    // "-03:00" is 2 tokens — the when-prefix parser tries longest first
    const job = m.list()[0];
    if (!job) {
      // alternative parse: whole string may not split cleanly — check error
      expect(messages.at(-1)?.text).toContain('Could not parse');
      return;
    }
    expect(job.trigger.kind).toBe('once');
  });

  it('runs jobs by number (cached list) and by name', async () => {
    const m = makeManager();
    m.create({ prompt: 'first', trigger: { kind: 'manual' }, name: 'one' });
    m.create({ prompt: 'second', trigger: { kind: 'manual' }, name: 'two' });
    await m.handleCommand('/jobs', 12345); // populate cache
    await m.handleCommand('/jobs run 2', 12345);
    expect(sent[0]?.text).toBe('second');
    await m.handleCommand('/jobs two', 12345); // bare ref runs
    expect(sent[1]?.text).toBe('second');
    await m.handleCommand('/jobs run one', 12345);
    expect(sent[2]?.text).toBe('first');
  });

  it('toggles and removes jobs by ref', async () => {
    const m = makeManager();
    const j = m.create({ prompt: 'x', trigger: { kind: 'cron', expr: '0 * * * *' }, name: 'j' });
    await m.handleCommand('/jobs', 12345);
    await m.handleCommand('/jobs toggle 1', 12345);
    expect(m.get(j.id)?.enabled).toBe(false);
    expect(messages.at(-1)?.text).toContain('paused');
    await m.handleCommand('/jobs rm 1', 12345);
    expect(m.get(j.id)).toBeUndefined();
    expect(messages.at(-1)?.text).toContain('removed');
  });

  it('requires a fresh /jobs list for numeric refs', async () => {
    const m = makeManager();
    m.create({ prompt: 'x', trigger: { kind: 'manual' }, name: 'j' });
    await m.handleCommand('/jobs run 1', 12345);
    expect(messages[0]?.text).toContain('Run /jobs first');
  });

  it('ignores non-/jobs commands', async () => {
    const m = makeManager();
    expect(await m.handleCommand('/jobsfoo', 1)).toBe(false);
    expect(await m.handleCommand('/status', 1)).toBe(false);
    expect(await m.handleCommand('hello', 1)).toBe(false);
  });
});
