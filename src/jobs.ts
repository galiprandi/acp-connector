import * as chrono from 'chrono-node';
import cron, { type ScheduledTask } from 'node-cron';
import { log } from './logger.js';
import type { StateStore } from './state.js';

/**
 * Unified scheduled-work model. One job = a prompt + a trigger:
 *
 *   once   — fires a single time at `at` (ISO), then is deleted
 *   cron   — fires on a 5-field cron `expr`, recurring
 *   manual — never fires on its own; `/jobs run` or the agent triggers it
 *            (this is what "routines" became — agent-authorable skills
 *            the operator fires with a short command)
 *
 * Replaces the old reminders + cron + routines trio. Persisted in
 * state.json via StateStore; timers are in-process.
 */

export type JobManaged = 'operator' | 'agent';

export type JobTrigger =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expr: string }
  | { kind: 'manual' };

export interface Job {
  id: string;
  /** Optional human name — enables `/jobs run <name>` and agent updates. */
  name?: string;
  prompt: string;
  trigger: JobTrigger;
  enabled: boolean;
  managed: JobManaged;
  chatId?: number | string;
  createdAt: string;
}

/** Max agent-created jobs (bounds restart-surviving resource use). */
export const MAX_AGENT_JOBS = 50;
/** Hard cap on total persisted jobs. */
export const MAX_JOBS = 200;
/** Once-jobs past `at` by more than this are discarded on load. */
export const JOB_ONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often due-but-undeliverable once jobs are retried. */
export const RETRY_INTERVAL_MS = 30 * 1000;
/** `/jobs` numeric refs resolve against the last listing for this long. */
const JOBS_LIST_TTL_MS = 10 * 60 * 1000;
/** Max leading tokens tried as the "when" part of `/jobs add`. */
const MAX_WHEN_TOKENS = 8;

type EnqueueFn = (text: string, chatId: number | string, source: 'job' | 'agent-job') => void;
type SendFn = (chatId: number | string, text: string) => Promise<void>;

export interface JobManagerOptions {
  store: StateStore;
  /** Fallback chat for jobs without an explicit chatId (first allowed id). */
  allowedChatIds: Array<number | string>;
  enqueue: EnqueueFn;
  sendMessage: SendFn;
  /** `config.timezone` — required to resolve naive absolute times. */
  timezone?: string;
  /** True when a prompt can be enqueued right now (agent session up). */
  canDeliver?: () => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

const _idChars = 'abcdefghijklmnopqrstuvwxyz0123456789';

function newId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += _idChars[Math.floor(Math.random() * _idChars.length)];
  }
  return id;
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

const _EVERY_RE =
  /^\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;

/**
 * Convert a human interval ("30m", "2h", "1d", "1w") into a 5-field cron
 * expression. Returns null when the interval cannot be represented
 * (callers should then ask for a raw cron `expr`).
 */
export function everyToCron(every: string): string | null {
  const m = _EVERY_RE.exec(every);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('m')) {
    if (n >= 60 || 60 % n !== 0) return null;
    return `*/${n} * * * *`;
  }
  if (unit.startsWith('h')) {
    if (n === 24) return '0 0 * * *';
    if (n >= 24 || 24 % n !== 0) return null;
    return `0 */${n} * * *`;
  }
  if (unit.startsWith('w')) {
    if (n !== 1) return null;
    return '0 0 * * 0';
  }
  // days
  if (n >= 32) return null;
  return `0 0 */${n} * *`;
}

// ---------------------------------------------------------------------------
// Timezone-aware time parsing (moved from reminders.ts)
// ---------------------------------------------------------------------------

const _dtfCache = new Map<string, Intl.DateTimeFormat>();

function _dtf(tz: string): Intl.DateTimeFormat {
  let dtf = _dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    _dtfCache.set(tz, dtf);
  }
  return dtf;
}

/** Offset (ms) of `tz` east of UTC at the given instant. */
export function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = _dtf(tz).formatToParts(utcMs);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return wall - utcMs;
}

/** Interpret a Date's system-local wall-clock fields as wall time in `tz`. */
export function zoneWallToUtc(wall: Date, tz: string): number {
  const guess = Date.UTC(
    wall.getFullYear(),
    wall.getMonth(),
    wall.getDate(),
    wall.getHours(),
    wall.getMinutes(),
    wall.getSeconds(),
    wall.getMilliseconds()
  );
  const off1 = tzOffsetMs(tz, guess);
  let utc = guess - off1;
  const off2 = tzOffsetMs(tz, utc);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

/** A Date whose system-local wall-clock fields equal `now`'s fields in `tz`. */
function _wallClockInZone(now: Date, tz: string): Date {
  const parts = _dtf(tz).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return new Date(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
}

const _DURATION_RE =
  /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;

const _DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** True when the datetime string carries an explicit zone/offset. */
const _EXPLICIT_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})\s*$/i;

/** Resolve the system timezone (used when config has no `timezone`). */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function _hasExplicitZone(text: string): boolean {
  return (
    _EXPLICIT_ZONE_RE.test(text) ||
    (/^\d{4}-\d{2}-\d{2}T/.test(text) && /[zZ]|[+-]\d{2}/.test(text.slice(10)))
  );
}

/** True when the input is a pure duration ("30m", "in 45 minutes"). */
export function isDurationInput(text: string): boolean {
  const t = text.trim();
  return _DURATION_RE.test(t) || _DURATION_RE.test(t.replace(/^in\s+/i, ''));
}

/**
 * True when the input is an absolute wall time with no explicit zone —
 * i.e. it needs `config.timezone` to resolve correctly.
 */
export function needsExplicitTimezone(input: string): boolean {
  const text = input.trim();
  if (!text || _hasExplicitZone(text)) return false;
  const bare = text.replace(/^in\s+/i, '');
  if (_DURATION_RE.test(text) || _DURATION_RE.test(bare)) return false;
  return true;
}

function _parseAbsolute(text: string, timezone: string | undefined, now: number): number | null {
  if (_hasExplicitZone(text)) {
    const ts = Date.parse(text);
    return Number.isNaN(ts) ? null : ts;
  }
  if (!timezone) return null;
  const ref = _wallClockInZone(new Date(now), timezone);
  const parsed = chrono.parseDate(text, ref);
  if (!parsed) return null;
  return zoneWallToUtc(parsed, timezone);
}

/**
 * Parse a human/ISO datetime into a UTC instant (ms since epoch).
 * 'in' = relative delay or absolute; both resolve naive wall times in
 * `timezone` — never the host's system zone.
 */
export function parseWhenTime(
  input: string,
  timezone: string | undefined,
  now: number
): number | null {
  const text = input.trim();
  if (!text) return null;
  const bare = text.replace(/^in\s+/i, '');
  const m = _DURATION_RE.exec(text) ?? _DURATION_RE.exec(bare);
  if (m) {
    const ms = Number(m[1]) * _DURATION_UNIT_MS[m[2].toLowerCase()];
    return now + ms;
  }
  const ts = _parseAbsolute(text, timezone, now);
  return ts !== null && ts > now ? ts : null;
}

/**
 * Format a fire instant for chat/API confirmation, rendered in `timezone`
 * with its GMT offset so the operator can spot a wrong-zone schedule.
 */
export function formatFiresAt(iso: string, timezone?: string): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  }).format(new Date(iso));
  return timezone ? `${when} (${timezone})` : `${when} — no config.timezone set (shown in UTC)`;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface CronEntry {
  task: ScheduledTask;
  job: Job;
}

export class JobManager {
  private jobs: Job[] = [];
  private cronTasks = new Map<string, CronEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private lastList: { jobs: Job[]; at: number } | null = null;

  private store: StateStore;
  private allowedChatIds: Array<number | string>;
  private enqueue: EnqueueFn;
  private sendMessage: SendFn;
  private timezone?: string;
  private canDeliver: () => boolean;
  private now: () => number;
  /** Optional event hook — the bridge wires webhook fan-out here. */
  onEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;

  constructor({
    store,
    allowedChatIds,
    enqueue,
    sendMessage,
    timezone,
    canDeliver,
    now,
  }: JobManagerOptions) {
    this.store = store;
    this.allowedChatIds = allowedChatIds;
    this.enqueue = enqueue;
    this.sendMessage = sendMessage;
    this.timezone = timezone;
    this.canDeliver = canDeliver ?? (() => true);
    this.now = now ?? Date.now;
    this.jobs = this._load();
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    // Drop long-expired once jobs, then schedule everything enabled.
    const now = this.now();
    this.jobs = this.jobs.filter(
      (j) => j.trigger.kind !== 'once' || now - Date.parse(j.trigger.at) < JOB_ONCE_TTL_MS
    );
    this._persist();
    for (const j of this.jobs) this._schedule(j);
    this.flushDue();
    this.retryTimer = setInterval(() => this.flushDue(), RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const { task } of this.cronTasks.values()) task.stop();
    this.cronTasks.clear();
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // ------------------------------------------------------------ CRUD

  list(): Job[] {
    // Stable display order: once (soonest first), cron, manual.
    const rank = (j: Job) => (j.trigger.kind === 'once' ? 0 : j.trigger.kind === 'cron' ? 1 : 2);
    return [...this.jobs].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (a.trigger.kind === 'once' && b.trigger.kind === 'once') {
        return a.trigger.at.localeCompare(b.trigger.at);
      }
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });
  }

  get(ref: string): Job | undefined {
    const needle = ref.trim().toLowerCase();
    return this.jobs.find((j) => j.id === needle || (j.name ?? '').toLowerCase() === needle);
  }

  /**
   * Create a job. `trigger` is already a validated JobTrigger.
   * @throws on validation failure or cap reached.
   */
  create(input: {
    prompt: string;
    trigger: JobTrigger;
    name?: string;
    managed?: JobManaged;
    chatId?: number | string;
    enabled?: boolean;
  }): Job {
    const managed = input.managed ?? 'operator';
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt is required');
    if (input.trigger.kind === 'once') {
      const ts = Date.parse(input.trigger.at);
      if (Number.isNaN(ts)) throw new Error(`invalid fire time: ${input.trigger.at}`);
      if (ts <= this.now()) throw new Error('one-shot job must be in the future');
    }
    if (input.trigger.kind === 'cron' && !cron.validate(input.trigger.expr)) {
      throw new Error(`invalid cron expression: ${input.trigger.expr}`);
    }
    if (input.trigger.kind === 'manual' && !input.name?.trim()) {
      throw new Error('manual jobs require a name (they are triggered by it)');
    }
    if (input.name) {
      const wanted = input.name.toLowerCase();
      const clash = this.jobs.find((j) => (j.name ?? '').toLowerCase() === wanted);
      if (clash) throw new Error(`job "${input.name}" already exists`);
    }
    if (
      managed === 'agent' &&
      this.jobs.filter((j) => j.managed === 'agent').length >= MAX_AGENT_JOBS
    ) {
      throw new Error(`agent job cap reached (${MAX_AGENT_JOBS})`);
    }
    if (this.jobs.length >= MAX_JOBS) throw new Error(`job limit reached (${MAX_JOBS})`);

    const job: Job = {
      id: newId(),
      name: input.name?.trim() || undefined,
      prompt,
      trigger: input.trigger,
      enabled: input.enabled !== false,
      managed,
      chatId: input.chatId,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.jobs.push(job);
    this._persist();
    this._schedule(job);
    log.info(`⚙️ job ${job.id}${job.name ? ` (${job.name})` : ''} created [${job.trigger.kind}]`);
    return job;
  }

  /**
   * Update prompt/trigger/name/enabled. Reschedules when the trigger or
   * enabled state changes.
   */
  update(
    id: string,
    patch: { prompt?: string; trigger?: JobTrigger; name?: string; enabled?: boolean }
  ): Job | null {
    const job = this.get(id);
    if (!job) return null;
    if (patch.prompt !== undefined) {
      if (!patch.prompt.trim()) throw new Error('prompt cannot be empty');
      job.prompt = patch.prompt.trim();
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name) {
        const clash = this.jobs.find(
          (j) => j !== job && (j.name ?? '').toLowerCase() === name.toLowerCase()
        );
        if (clash) throw new Error(`job "${name}" already exists`);
      }
      job.name = name || undefined;
    }
    if (patch.trigger !== undefined) {
      if (patch.trigger.kind === 'once') {
        const ts = Date.parse(patch.trigger.at);
        if (Number.isNaN(ts)) throw new Error(`invalid fire time: ${patch.trigger.at}`);
        if (ts <= this.now()) throw new Error('one-shot job must be in the future');
      }
      if (patch.trigger.kind === 'cron' && !cron.validate(patch.trigger.expr)) {
        throw new Error(`invalid cron expression: ${patch.trigger.expr}`);
      }
      if (patch.trigger.kind === 'manual' && !job.name) {
        throw new Error('manual jobs require a name');
      }
      job.trigger = patch.trigger;
    } else if (patch.trigger === undefined && job.trigger.kind === 'manual' && !job.name) {
      throw new Error('manual jobs require a name');
    }
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    this._unschedule(job.id);
    this._persist();
    if (job.enabled) this._schedule(job);
    return job;
  }

  remove(id: string): boolean {
    const idx = this.jobs.findIndex(
      (j) => j.id === id || (j.name ?? '').toLowerCase() === id.toLowerCase()
    );
    if (idx < 0) return false;
    const [job] = this.jobs.splice(idx, 1);
    this._unschedule(job.id);
    this._persist();
    return true;
  }

  /** Pause (false) or resume (true). Returns the new enabled state. */
  toggle(id: string): boolean | null {
    const job = this.get(id);
    if (!job) return null;
    job.enabled = !job.enabled;
    this._unschedule(job.id);
    this._persist();
    if (job.enabled) this._schedule(job);
    return job.enabled;
  }

  /** Deliver the job's prompt immediately, schedule untouched. */
  run(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    this._deliver(job);
    return true;
  }

  /**
   * One-line summary for /status: enabled-job counts by trigger kind
   * plus the soonest upcoming one-shot fire. Null when nothing is
   * scheduled.
   */
  summary(): string | null {
    const enabled = this.list().filter((j) => j.enabled);
    if (enabled.length === 0) return null;
    const once = enabled.filter((j) => j.trigger.kind === 'once');
    const cron = enabled.filter((j) => j.trigger.kind === 'cron');
    const manual = enabled.filter((j) => j.trigger.kind === 'manual');
    const parts: string[] = [];
    if (once.length > 0) parts.push(`${once.length} once`);
    if (cron.length > 0) parts.push(`${cron.length} cron`);
    if (manual.length > 0) parts.push(`${manual.length} manual`);
    let out = `${enabled.length} job(s) (${parts.join(' · ')})`;
    const next = once
      .map((j) => (j.trigger.kind === 'once' ? j : null))
      .filter((j): j is Job => j !== null)
      .sort((a, b) =>
        a.trigger.kind === 'once' && b.trigger.kind === 'once'
          ? a.trigger.at.localeCompare(b.trigger.at)
          : 0
      )[0];
    if (next && next.trigger.kind === 'once') {
      const ms = Date.parse(next.trigger.at) - this.now();
      const rel =
        ms < 3_600_000
          ? `${Math.max(1, Math.round(ms / 60_000))}m`
          : ms < 86_400_000
            ? `${Math.round(ms / 3_600_000)}h`
            : `${Math.round(ms / 86_400_000)}d`;
      out += ` — next "${next.name ?? next.id}" in ${rel}`;
    }
    return out;
  }

  // ------------------------------------------------------------ firing

  /**
   * Deliver every once-job whose `at` is past, oldest first. Undeliverable
   * entries stay and are retried — a late action beats a lost one.
   */
  flushDue(): void {
    const now = this.now();
    const due = this.jobs
      .filter((j) => j.trigger.kind === 'once' && Date.parse(j.trigger.at) <= now)
      .sort((a, b) =>
        a.trigger.kind === 'once' && b.trigger.kind === 'once'
          ? a.trigger.at.localeCompare(b.trigger.at)
          : 0
      );
    for (const j of due) {
      if (!this.canDeliver()) {
        log.info(`⚙️ job ${j.id} due but agent not connected — kept for retry`);
        continue;
      }
      this._deliver(j);
      this.remove(j.id); // once jobs are deleted on delivery
      log.info(`⚙️ job ${j.id} delivered`);
    }
  }

  private _deliver(job: Job): void {
    const chatId = job.chatId ?? this.allowedChatIds[0];
    if (chatId === undefined || chatId === null) {
      log.warn(`⚙️ job ${job.id} has no chat target — skipped`);
      this.onEvent?.('job.failed', {
        id: job.id,
        name: job.name,
        managed: job.managed,
        trigger: job.trigger,
        error: 'no chat target',
      });
      return;
    }
    this.onEvent?.('job.fired', {
      id: job.id,
      name: job.name,
      managed: job.managed,
      trigger: job.trigger,
      prompt: job.prompt,
      chatId,
    });
    if (job.managed === 'agent') {
      // Agent jobs are remote content: prefix so a leading "/" is never
      // parsed as a bridge command, and flag the source accordingly.
      const label = job.name ?? job.id;
      this.enqueue(`[Agent job ${label}] ${job.prompt}`, chatId, 'agent-job');
      return;
    }
    this.enqueue(job.prompt, chatId, 'job');
  }

  // ------------------------------------------------------------ scheduling

  private _schedule(job: Job): void {
    if (!job.enabled) return;
    if (job.trigger.kind === 'once') {
      const delay = Math.max(0, Date.parse(job.trigger.at) - this.now());
      // setTimeout max is ~24.8 days; re-arm past that.
      const clamped = Math.min(delay, 2_000_000_000);
      const t = setTimeout(() => {
        this.timers.delete(job.id);
        if (job.trigger.kind === 'once' && Date.parse(job.trigger.at) > this.now()) {
          this._schedule(job); // clamp re-arm
          return;
        }
        this.flushDue();
      }, clamped);
      t.unref?.();
      this.timers.set(job.id, t);
      return;
    }
    if (job.trigger.kind === 'cron') {
      if (!cron.validate(job.trigger.expr)) {
        log.warn(`⚙️ job ${job.id} invalid cron expr: ${job.trigger.expr}`);
        return;
      }
      const task = cron.schedule(job.trigger.expr, () => {
        log.info(`⚙️ job ${job.id}${job.name ? ` (${job.name})` : ''} fired`);
        this._deliver(job);
      });
      this.cronTasks.set(job.id, { task, job });
      return;
    }
    // manual: nothing to schedule
  }

  private _unschedule(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    const entry = this.cronTasks.get(id);
    if (entry) {
      entry.task.stop();
      this.cronTasks.delete(id);
    }
  }

  // ------------------------------------------------------------ persistence

  private _persist(): void {
    this.store.set('jobs', this.jobs);
  }

  private _load(): Job[] {
    const raw = this.store.get('jobs');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (j): j is Job =>
        !!j &&
        typeof j === 'object' &&
        typeof (j as Job).id === 'string' &&
        typeof (j as Job).prompt === 'string' &&
        !!(j as Job).trigger &&
        typeof (j as Job).trigger === 'object'
    );
  }

  // ------------------------------------------------------------ /jobs command

  /** Resolve a numeric ref against the cached last /jobs listing. */
  private _resolveJobRef(arg: string): { job: Job } | { error: string } {
    if (/^\d+$/.test(arg)) {
      const cached = this.lastList;
      const fresh = cached && this.now() - cached.at < JOBS_LIST_TTL_MS ? cached.jobs : null;
      if (!fresh) return { error: 'Run /jobs first to get a numbered list.' };
      const hit = fresh[Number.parseInt(arg, 10) - 1];
      if (!hit) {
        return { error: `No job #${arg} — run /jobs to see ${fresh.length} entries.` };
      }
      return { job: hit };
    }
    const job = this.get(arg);
    if (!job) return { error: `Job "${arg}" not found — run /jobs to list.` };
    return { job };
  }

  async handleCommand(text: string, chatId: number | string): Promise<boolean> {
    if (!text.startsWith('/jobs')) return false;
    // Only the exact command or `/jobs <sub>` — not `/jobsfoo`.
    if (!/^\/jobs(\s|$)/.test(text)) return false;
    const parts = text.slice(1).split(/\s+/);
    const sub = parts[1]?.toLowerCase();
    const rest = parts.slice(2).join(' ').trim();

    switch (sub) {
      case undefined:
      case 'list':
        return this._cmdList(chatId);
      case 'add':
        return this._cmdAdd(rest, chatId);
      case 'run':
      case 'toggle':
      case 'rm':
      case 'delete':
      case 'remove':
        return this._cmdAction(sub, rest, chatId);
      default:
        // `/jobs <ref>` — numeric or name runs the job directly (picker UX)
        if (sub && !['help'].includes(sub)) {
          const resolved = this._resolveJobRef(sub);
          if ('job' in resolved) {
            await this.sendMessage(
              chatId,
              `▶ Running \`${resolved.job.name ?? resolved.job.id}\`…`
            );
            this.run(resolved.job.id);
            return true;
          }
        }
        await this.sendMessage(chatId, this._usage());
        return true;
    }
  }

  private _usage(): string {
    return [
      '*Jobs commands:*',
      '/jobs — list all jobs',
      '/jobs add `[as <name>] <when> <prompt>` — schedule or create manual',
      '  when: `in 20m` · `every 1h` · `friday 9am` · `0 9 * * 1-5` · `manual`',
      '/jobs run `<n|name>` — run now',
      '/jobs toggle `<n|name>` — pause/resume',
      '/jobs rm `<n|name>` — delete',
    ].join('\n');
  }

  private async _cmdList(chatId: number | string): Promise<boolean> {
    const jobs = this.list();
    this.lastList = { jobs, at: this.now() };
    if (jobs.length === 0) {
      await this.sendMessage(chatId, 'No jobs. Add one: /jobs add `in 20m check the oven`');
      return true;
    }
    const lines = jobs.map((j, i) => {
      const state = j.enabled ? ' ' : '⏸';
      const owner = j.managed === 'agent' ? ' 🤖' : '';
      const ref = j.name ? `\`${j.name}\`` : `\`${j.id}\``;
      let when: string;
      if (j.trigger.kind === 'once') {
        when = `⏰ ${formatFiresAt(j.trigger.at, this.timezone)}`;
      } else if (j.trigger.kind === 'cron') {
        when = `🔁 \`${j.trigger.expr}\``;
      } else {
        when = '⚡ manual';
      }
      return `${state}${i + 1}. ${ref}${owner} — ${when} — ${j.prompt.slice(0, 50)}`;
    });
    await this.sendMessage(
      chatId,
      `*Jobs:*\n${lines.join('\n')}\n\nRun: /jobs run <n|name> · bare /jobs <n> also runs.`
    );
    return true;
  }

  /**
   * Parse `/jobs add [as <name>] <when> <prompt>`.
   * `<when>` is one of: `manual`, `every <dur>`, a 5-field cron expr,
   * or a natural/relative datetime (longest-prefix chrono match).
   */
  private _parseAdd(rest: string): {
    job?: Omit<Job, 'id' | 'createdAt' | 'enabled' | 'managed'> & { enabled?: boolean };
    error?: string;
  } {
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { error: this._usage() };

    // Optional leading `as <name>`
    let name: string | undefined;
    if (tokens[0] === 'as' && tokens.length >= 2) {
      name = tokens[1];
      tokens.splice(0, 2);
      if (tokens.length === 0) return { error: 'Missing prompt after `as <name>`.' };
    }

    // manual
    if (tokens[0] === 'manual') {
      const prompt = tokens.slice(1).join(' ');
      if (!prompt) return { error: 'Usage: /jobs add `as <name> manual <prompt>`' };
      if (!name) return { error: 'Manual jobs need a name: /jobs add `as <name> manual <prompt>`' };
      return { job: { name, prompt, trigger: { kind: 'manual' } } };
    }

    // every <dur>  (1 or 2 tokens: "1h" or "1 hour")
    if (tokens[0] === 'every') {
      for (const span of [1, 2]) {
        if (tokens.length < 1 + span + 1) continue;
        const candidate = tokens.slice(1, 1 + span).join(' ');
        const expr = everyToCron(candidate);
        if (expr) {
          return {
            job: {
              name,
              prompt: tokens.slice(1 + span).join(' '),
              trigger: { kind: 'cron', expr },
            },
          };
        }
      }
      return {
        error:
          'Cannot express that interval as cron — use a raw 5-field expr, e.g. `/jobs add `*/45 * * * *` <prompt>`',
      };
    }

    // 5-field cron expr
    if (tokens.length >= 6) {
      const candidate = tokens.slice(0, 5).join(' ');
      const rest2 = tokens.slice(5).join(' ');
      if (cron.validate(candidate) && rest2) {
        return { job: { name, prompt: rest2, trigger: { kind: 'cron', expr: candidate } } };
      }
    }

    // once: natural/relative datetime — longest prefix that parses wins
    const now = this.now();
    const maxLead = Math.min(tokens.length - 1, MAX_WHEN_TOKENS);
    for (let i = maxLead; i >= 1; i--) {
      const candidate = tokens.slice(0, i).join(' ');
      const prompt = tokens.slice(i).join(' ');
      if (!prompt) continue;
      if (!this.timezone && needsExplicitTimezone(candidate)) continue;
      const ts = parseWhenTime(candidate, this.timezone, now);
      if (ts === null) continue;
      if (!isDurationInput(candidate) && !this._chronoCovers(candidate)) continue;
      return {
        job: {
          name,
          prompt,
          trigger: { kind: 'once', at: new Date(ts).toISOString() },
        },
      };
    }

    return {
      error:
        'Could not parse the schedule. Try `in 20m`, `every 1h`, a date like `friday 9am`, a cron expr like `0 9 * * 1-5`, or `manual`. Absolute times need `timezone` in acp-connector.jsonc or an explicit offset like -03:00.',
    };
  }

  /** True when chrono consumed the whole candidate (no partial matches). */
  private _chronoCovers(candidate: string): boolean {
    const text = candidate.trim();
    const parsed = chrono.parse(text);
    if (parsed.length === 0) return true;
    return (
      parsed.length === 1 &&
      parsed[0].index === 0 &&
      parsed[0].index + parsed[0].text.length === text.length
    );
  }

  private async _cmdAdd(rest: string, chatId: number | string): Promise<boolean> {
    const parsed = this._parseAdd(rest);
    if (parsed.error || !parsed.job) {
      await this.sendMessage(chatId, parsed.error ?? this._usage());
      return true;
    }
    try {
      const job = this.create({
        ...parsed.job,
        managed: 'operator',
        chatId: Number(chatId) || chatId,
      });
      await this.sendMessage(
        chatId,
        `✅ Job \`${job.name ?? job.id}\` added — ${this._describe(job)}`
      );
    } catch (err) {
      await this.sendMessage(chatId, `Failed to add job: ${(err as Error).message}`);
    }
    return true;
  }

  private _describe(job: Job): string {
    const when =
      job.trigger.kind === 'once'
        ? formatFiresAt(job.trigger.at, this.timezone)
        : job.trigger.kind === 'cron'
          ? `cron \`${job.trigger.expr}\``
          : 'manual';
    return `${when} — ${job.prompt.slice(0, 60)}`;
  }

  private async _cmdAction(
    action: string,
    rest: string,
    chatId: number | string
  ): Promise<boolean> {
    const ref = rest.trim();
    if (!ref) {
      await this.sendMessage(chatId, `Usage: /jobs ${action} \`<n|name>\``);
      return true;
    }
    const resolved = this._resolveJobRef(ref);
    if ('error' in resolved) {
      await this.sendMessage(chatId, resolved.error);
      return true;
    }
    const job = resolved.job;
    const label = job.name ?? job.id;

    if (action === 'run') {
      this.run(job.id);
      await this.sendMessage(chatId, `▶ Running \`${label}\`…`);
      return true;
    }
    if (action === 'toggle') {
      const enabled = this.toggle(job.id);
      await this.sendMessage(
        chatId,
        `${enabled ? '▶' : '⏸'} Job \`${label}\` ${enabled ? 'resumed' : 'paused'}.`
      );
      return true;
    }
    // rm / delete / remove
    this.remove(job.id);
    await this.sendMessage(chatId, `🗑 Job \`${label}\` removed.`);
    return true;
  }
}
