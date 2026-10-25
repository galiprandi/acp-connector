import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as chrono from 'chrono-node';
import { log } from './logger.js';

/**
 * A one-shot reminder owned by the agent. Stored in
 * `.acp-connector/reminders.json` (next to acp-connector.jsonc).
 * Future reminders only — there is no state machine: a reminder is
 * either waiting to fire or gone (deleted on delivery).
 */
export interface Reminder {
  id: string;
  prompt: string;
  /** Fire instant, ISO 8601 UTC. */
  firesAt: string;
  /** Creation instant, ISO 8601 UTC. */
  createdAt: string;
}

/** Maximum active reminders. */
export const MAX_REMINDERS = 50;

/** Entries past firesAt by more than this are discarded on load. */
export const REMINDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often due-but-undeliverable reminders are retried. */
export const RETRY_INTERVAL_MS = 30 * 1000;

type LogFn = (msg: string) => void;

/**
 * Returns true when a prompt can be enqueued right now (agent session
 * active and a chat id available). Delivery is retried later when false.
 */
type CanDeliverFn = () => boolean;

/** Enqueue the delivered text into the bridge queue. */
type DeliverFn = (text: string) => void;

export interface ReminderManagerOptions {
  /** Path to the JSON store file. */
  storePath: string;
  canDeliver: CanDeliverFn;
  deliver: DeliverFn;
  onLog?: LogFn | null;
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
// Time parsing
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

/**
 * Offset (ms) of `tz` east of UTC at the given instant.
 */
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

/**
 * Interpret a Date's system-local wall-clock fields as wall time in `tz`
 * and return the corresponding UTC instant (ms).
 */
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

/**
 * A Date whose system-local wall-clock fields equal `now`'s fields in `tz`.
 * Used as the chrono reference so "tomorrow 10am" resolves in the
 * operator's timezone even when the host runs elsewhere.
 */
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

/**
 * Resolve the system timezone (used when config has no `timezone`).
 */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Parse a human/ISO datetime into a UTC instant (ms since epoch).
 *
 * @param input raw string ("30m", "2 hours", "tomorrow 10am",
 *   "mañana 10:00", "2026-03-01T10:00", ...)
 * @param mode 'in' = relative to now; 'at' = absolute wall time in `timezone`.
 * @param timezone IANA zone for `at` strings without an explicit offset.
 * @param now current instant (ms).
 * @returns UTC ms, or null when unparseable or not in the future.
 */
export function parseReminderTime(
  input: string,
  mode: 'in' | 'at',
  timezone: string,
  now: number
): number | null {
  const text = input.trim();
  if (!text) return null;

  if (mode === 'in') {
    const m = _DURATION_RE.exec(text);
    if (m) {
      const ms = Number(m[1]) * _DURATION_UNIT_MS[m[2].toLowerCase()];
      return now + ms;
    }
    // chrono handles "in 2 hours", "in 30 minutes", "tomorrow" etc.
    const parsed =
      chrono.parseDate(`in ${text}`, new Date(now)) ?? chrono.parseDate(text, new Date(now));
    if (!parsed) return null;
    const ts = parsed.getTime();
    return ts > now ? ts : null;
  }

  // mode === 'at'
  if (
    _EXPLICIT_ZONE_RE.test(text) ||
    (/^\d{4}-\d{2}-\d{2}T/.test(text) && /[zZ]|[+-]\d{2}/.test(text.slice(10)))
  ) {
    const ts = Date.parse(text);
    if (Number.isNaN(ts)) return null;
    return ts;
  }
  // Naive wall time: let chrono resolve it against "now" as seen in the
  // operator's timezone, then convert that wall time to UTC in `timezone`.
  const ref = _wallClockInZone(new Date(now), timezone);
  const parsed = chrono.parseDate(text, ref);
  if (!parsed) return null;
  return zoneWallToUtc(parsed, timezone);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Schedules one-shot agent reminders. Persistence is a flat JSON file;
 * timers are in-process setTimeout. A fired reminder is delivered via the
 * bridge queue and deleted. When delivery is not possible (no agent
 * session, no chat id) the entry is kept and retried — a late action
 * beats a lost one.
 */
export class ReminderManager {
  storePath: string;
  canDeliver: CanDeliverFn;
  deliver: DeliverFn;
  onLog: LogFn;
  now: () => number;

  private _reminders: Reminder[];
  private _timers: Map<string, ReturnType<typeof setTimeout>>;
  private _retryTimer: ReturnType<typeof setInterval> | null;

  constructor({ storePath, canDeliver, deliver, onLog = null, now }: ReminderManagerOptions) {
    this.storePath = storePath;
    this.canDeliver = canDeliver;
    this.deliver = deliver;
    this.onLog = onLog || ((msg) => log.info(msg));
    this.now = now || Date.now;
    this._reminders = [];
    this._timers = new Map();
    this._retryTimer = null;
  }

  /** Load the store, drop expired entries, schedule everything due. */
  start(): void {
    this._load();
    const now = this.now();
    this._reminders = this._reminders.filter((r) => now - Date.parse(r.firesAt) < REMINDER_TTL_MS);
    this._save();
    for (const r of this._reminders) {
      this._schedule(r);
    }
    // Past-due entries on boot are delivered immediately (or kept for
    // retry when the agent is not connected yet).
    this.flushDue();
    this._retryTimer = setInterval(() => this.flushDue(), RETRY_INTERVAL_MS);
    this._retryTimer.unref?.();
  }

  stop(): void {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
  }

  /**
   * Create and schedule a reminder.
   * @param firesAt UTC instant (ms or ISO string).
   * @throws when the cap (MAX_REMINDERS) is reached or firesAt is not future.
   */
  create(prompt: string, firesAt: number | string): Reminder {
    const ts = typeof firesAt === 'number' ? firesAt : Date.parse(firesAt);
    if (Number.isNaN(ts)) throw new Error(`invalid firesAt: ${firesAt}`);
    if (ts <= this.now()) throw new Error('reminder must be in the future');
    if (this._reminders.length >= MAX_REMINDERS) {
      throw new Error(`reminder limit reached (${MAX_REMINDERS})`);
    }
    const reminder: Reminder = {
      id: newId(),
      prompt,
      firesAt: new Date(ts).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
    };
    this._reminders.push(reminder);
    this._save();
    this._schedule(reminder);
    this.onLog(`⏰ reminder ${reminder.id} scheduled for ${reminder.firesAt}`);
    return reminder;
  }

  list(): Reminder[] {
    return [...this._reminders].sort((a, b) => a.firesAt.localeCompare(b.firesAt));
  }

  cancel(id: string): boolean {
    const idx = this._reminders.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this._reminders.splice(idx, 1);
    const t = this._timers.get(id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(id);
    }
    this._save();
    return true;
  }

  /**
   * Reschedule and/or reword an existing reminder.
   * @returns the updated reminder, or null when not found.
   */
  update(id: string, patch: { firesAt?: number | string; prompt?: string }): Reminder | null {
    const r = this._reminders.find((x) => x.id === id);
    if (!r) return null;
    if (patch.firesAt !== undefined) {
      const ts = typeof patch.firesAt === 'number' ? patch.firesAt : Date.parse(patch.firesAt);
      if (Number.isNaN(ts)) throw new Error(`invalid firesAt: ${patch.firesAt}`);
      if (ts <= this.now()) throw new Error('reminder must be in the future');
      r.firesAt = new Date(ts).toISOString();
    }
    if (patch.prompt !== undefined) r.prompt = patch.prompt;
    const t = this._timers.get(id);
    if (t) clearTimeout(t);
    this._schedule(r);
    this._save();
    return r;
  }

  /**
   * Deliver every reminder whose firesAt is in the past, oldest first.
   * Entries that cannot be delivered stay in the store.
   */
  flushDue(): void {
    const now = this.now();
    const due = this._reminders
      .filter((r) => Date.parse(r.firesAt) <= now)
      .sort((a, b) => a.firesAt.localeCompare(b.firesAt));
    for (const r of due) {
      if (!this.canDeliver()) {
        this.onLog(`⏰ reminder ${r.id} due but agent not connected — kept for retry`);
        continue;
      }
      this.deliver(`[Reminder ${r.id}] ${r.prompt}`);
      this._remove(r.id);
      this.onLog(`⏰ reminder ${r.id} delivered`);
    }
  }

  private _remove(id: string): void {
    const idx = this._reminders.findIndex((r) => r.id === id);
    if (idx >= 0) this._reminders.splice(idx, 1);
    const t = this._timers.get(id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(id);
    }
    this._save();
  }

  private _schedule(r: Reminder): void {
    const delay = Math.max(0, Date.parse(r.firesAt) - this.now());
    // setTimeout max is ~24.8 days; re-arm past that.
    const clamped = Math.min(delay, 2_000_000_000);
    const t = setTimeout(() => {
      this._timers.delete(r.id);
      if (Date.parse(r.firesAt) > this.now()) {
        this._schedule(r); // clamp re-arm
        return;
      }
      this.flushDue();
    }, clamped);
    t.unref?.();
    this._timers.set(r.id, t);
  }

  private _load(): void {
    this._reminders = [];
    if (!existsSync(this.storePath)) return;
    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this._reminders = parsed.filter(
          (r) => r && typeof r.id === 'string' && typeof r.prompt === 'string' && r.firesAt
        );
      }
    } catch (err) {
      this.onLog(`⚠️ failed to load reminders store: ${(err as Error).message}`);
    }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, `${JSON.stringify(this._reminders, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.onLog(`⚠️ failed to save reminders store: ${(err as Error).message}`);
    }
  }
}
