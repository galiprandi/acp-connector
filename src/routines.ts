import * as chrono from 'chrono-node';
import type { CronJob, Routine } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import type { CronManager } from './cron.js';
import { log } from './logger.js';
import {
  formatFiresAt,
  isReminderDuration,
  needsExplicitTimezone,
  parseReminderTime,
  type ReminderManager,
} from './reminders.js';

/**
 * Persist the current cron jobs (and optionally routines) back to
 * acp-connector.jsonc. Shared by the chat commands and the
 * reminders/cron MCP API so agent-managed jobs survive restarts.
 */
export function persistCronAndRoutines(cron: CronJob[], routines?: Routine[]): void {
  const config = loadConfig();
  if (!config) return;
  if (routines) config.routines = routines;
  config.cron = cron;
  saveConfig(config);
}

interface RoutineManagerOpts {
  routines: Routine[];
  cronManager: CronManager;
  reminderManager?: ReminderManager;
  /** `config.timezone` — required to resolve naive absolute reminder times. */
  timezone?: string;
  enqueue: (text: string, chatId?: number) => void;
  sendMessage: (chatId: number, text: string) => Promise<void>;
}

/** Max leading tokens tried as the "when" part of `/reminder add`. */
const MAX_WHEN_TOKENS = 8;

export class RoutineManager {
  private routines: Routine[];
  private cronManager: CronManager;
  private reminderManager?: ReminderManager;
  private timezone?: string;
  private enqueue: (text: string, chatId?: number) => void;
  private sendMessage: (chatId: number, text: string) => Promise<void>;

  constructor({
    routines,
    cronManager,
    reminderManager,
    timezone,
    enqueue,
    sendMessage,
  }: RoutineManagerOpts) {
    this.routines = routines || [];
    this.cronManager = cronManager;
    this.reminderManager = reminderManager;
    this.timezone = timezone;
    this.enqueue = enqueue;
    this.sendMessage = sendMessage;
  }

  async handleCommand(text: string, chatId: number): Promise<boolean> {
    if (!text.startsWith('/')) return false;

    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1).join(' ');

    switch (cmd) {
      case 'cron':
        return this._handleCron(args, chatId);
      case 'routine':
        return this._handleRoutine(args, chatId);
      case 'run':
        return this._handleRun(args, chatId);
      case 'reminder':
        return this._handleReminder(args, chatId);
      default:
        return false;
    }
  }

  private async _handleCron(args: string, chatId: number): Promise<boolean> {
    const [subcommand, ...rest] = args.split(/\s+/);
    const restStr = rest.join(' ');

    switch (subcommand) {
      case 'list':
        return this._cronList(chatId);
      case 'add':
        return this._cronAdd(restStr, chatId);
      case 'remove':
      case 'rm':
        return this._cronRemove(restStr, chatId);
      case 'toggle':
        return this._cronToggle(restStr, chatId);
      case 'run':
        return this._cronRun(restStr, chatId);
      default:
        await this.sendMessage(
          chatId,
          [
            '*Cron commands:*',
            '/cron list — list all jobs',
            '/cron add `<schedule> <prompt>` — add a job',
            '/cron remove `<name>` — remove a job',
            '/cron toggle `<name>` — pause/activate',
            '/cron run `<name>` — run now',
          ].join('\n')
        );
        return true;
    }
  }

  private async _cronList(chatId: number): Promise<boolean> {
    const jobs = this.cronManager.list();
    if (jobs.length === 0) {
      await this.sendMessage(chatId, 'No cron jobs configured.');
      return true;
    }
    const lines = jobs.map((j, i) => {
      const status = j.enabled === false ? '⏸' : '▶';
      return `${status} ${i}: \`${j.name}\` — \`${j.schedule}\` — ${j.prompt.slice(0, 50)}`;
    });
    await this.sendMessage(chatId, `*Cron jobs:*\n${lines.join('\n')}`);
    return true;
  }

  private async _cronAdd(restStr: string, chatId: number): Promise<boolean> {
    const tokens = restStr.split(/\s+/);
    if (tokens.length < 6) {
      await this.sendMessage(
        chatId,
        'Usage: /cron add `<schedule> <prompt>`\nExample: /cron add `0 9 * * *` do the briefing\nSchedule is 5 fields: minute hour day month weekday'
      );
      return true;
    }
    const schedule = tokens.slice(0, 5).join(' ');
    const prompt = tokens.slice(5).join(' ');
    const name = `cron-${Date.now()}`;

    const job = this.cronManager.add({ name, schedule, prompt, chatId });
    if (!job) {
      await this.sendMessage(chatId, `Failed to add cron job (name "${name}" may already exist).`);
      return true;
    }

    this._persist();
    await this.sendMessage(
      chatId,
      `✅ Cron job \`${name}\` added: \`${schedule}\` — ${prompt.slice(0, 60)}`
    );
    return true;
  }

  private async _cronRemove(restStr: string, chatId: number): Promise<boolean> {
    const name = restStr.trim();
    if (!name) {
      await this.sendMessage(chatId, 'Usage: /cron remove `<name>`');
      return true;
    }
    const removed = this.cronManager.remove(name);
    if (!removed) {
      await this.sendMessage(chatId, `Cron job "${name}" not found.`);
      return true;
    }
    this._persist();
    await this.sendMessage(chatId, `✅ Cron job \`${name}\` removed.`);
    return true;
  }

  private async _cronToggle(restStr: string, chatId: number): Promise<boolean> {
    const name = restStr.trim();
    if (!name) {
      await this.sendMessage(chatId, 'Usage: /cron toggle `<name>`');
      return true;
    }
    const newState = this.cronManager.toggle(name);
    await this.sendMessage(
      chatId,
      `${newState ? '▶' : '⏸'} Cron job \`${name}\` ${newState ? 'activated' : 'paused'}.`
    );
    this._persist();
    return true;
  }

  private async _cronRun(restStr: string, chatId: number): Promise<boolean> {
    const name = restStr.trim();
    if (!name) {
      await this.sendMessage(chatId, 'Usage: /cron run `<name>`');
      return true;
    }
    const result = this.cronManager.run(name);
    if (!result) {
      await this.sendMessage(chatId, `Cron job "${name}" not found.`);
      return true;
    }
    await this.sendMessage(chatId, `▶ Running \`${name}\`...`);
    return true;
  }

  private async _handleRoutine(args: string, chatId: number): Promise<boolean> {
    const [subcommand, ...rest] = args.split(/\s+/);
    const restStr = rest.join(' ');

    switch (subcommand) {
      case 'list':
        return this._routineList(chatId);
      case 'add':
        return this._routineAdd(restStr, chatId);
      case 'remove':
      case 'rm':
        return this._routineRemove(restStr, chatId);
      default:
        await this.sendMessage(
          chatId,
          [
            '*Routine commands:*',
            '/routine list — list all routines',
            '/routine add `<name> <prompt>` — add a routine',
            '/routine remove `<name>` — remove a routine',
          ].join('\n')
        );
        return true;
    }
  }

  private async _routineList(chatId: number): Promise<boolean> {
    if (this.routines.length === 0) {
      await this.sendMessage(chatId, 'No routines configured.');
      return true;
    }
    const lines = this.routines.map((r) => `\`${r.name}\` — ${r.prompt.slice(0, 60)}`);
    await this.sendMessage(chatId, `*Routines:*\n${lines.join('\n')}`);
    return true;
  }

  private async _routineAdd(restStr: string, chatId: number): Promise<boolean> {
    const spaceIdx = restStr.indexOf(' ');
    if (spaceIdx < 0) {
      await this.sendMessage(chatId, 'Usage: /routine add `<name> <prompt>`');
      return true;
    }
    const name = restStr.slice(0, spaceIdx);
    const prompt = restStr.slice(spaceIdx + 1);

    if (this.routines.find((r) => r.name === name)) {
      await this.sendMessage(chatId, `Routine "${name}" already exists.`);
      return true;
    }

    this.routines.push({ name, prompt });
    this._persist();
    await this.sendMessage(chatId, `✅ Routine \`${name}\` added.`);
    return true;
  }

  private async _routineRemove(restStr: string, chatId: number): Promise<boolean> {
    const name = restStr.trim();
    if (!name) {
      await this.sendMessage(chatId, 'Usage: /routine remove `<name>`');
      return true;
    }
    const idx = this.routines.findIndex((r) => r.name === name);
    if (idx < 0) {
      await this.sendMessage(chatId, `Routine "${name}" not found.`);
      return true;
    }
    this.routines.splice(idx, 1);
    this._persist();
    await this.sendMessage(chatId, `✅ Routine \`${name}\` removed.`);
    return true;
  }

  // ------------------------------------------------------------- /reminder

  private async _handleReminder(args: string, chatId: number): Promise<boolean> {
    const [subcommand, ...rest] = args.split(/\s+/);
    const restStr = rest.join(' ');

    switch (subcommand) {
      case 'list':
        return this._reminderList(chatId);
      case 'add':
        return this._reminderAdd(restStr, chatId);
      case 'remove':
      case 'rm':
      case 'cancel':
        return this._reminderRemove(restStr, chatId);
      default:
        await this.sendMessage(
          chatId,
          [
            '*Reminder commands:*',
            '/reminder list — list scheduled reminders',
            '/reminder add `<when> <prompt>` — one-shot reminder (e.g. `/reminder add in 20 minutes check the oven`)',
            '/reminder remove `<id>` — cancel a reminder',
          ].join('\n')
        );
        return true;
    }
  }

  private async _reminderList(chatId: number): Promise<boolean> {
    const mgr = this.reminderManager;
    if (!mgr) {
      await this.sendMessage(chatId, 'Reminders are not available on this bridge.');
      return true;
    }
    const items = mgr.list();
    if (items.length === 0) {
      await this.sendMessage(chatId, 'No reminders scheduled.');
      return true;
    }
    const lines = items.map(
      (r) =>
        `\`${r.id}\` ${r.managed === 'operator' ? '👤' : '🤖'} ${formatFiresAt(r.firesAt, this.timezone)} — ${r.prompt.slice(0, 60)}`
    );
    await this.sendMessage(chatId, `*Reminders:*\n${lines.join('\n')}`);
    return true;
  }

  /**
   * Resolve the leading tokens of `/reminder add <when> <prompt>` into a
   * fire instant. The longest prefix that parses as a complete "when"
   * wins — durations are anchored, and absolute strings must be fully
   * consumed by chrono so "in 20 minutes revisar" can't match just
   * "in 20 minutes".
   */
  private _parseWhenPrefix(args: string): { ts: number; rest: string } | { error: string } {
    const tokens = args.split(/\s+/).filter(Boolean);
    const now = Date.now();
    const maxLead = Math.min(tokens.length - 1, MAX_WHEN_TOKENS);
    for (let i = maxLead; i >= 1; i--) {
      const candidate = tokens.slice(0, i).join(' ');
      const rest = tokens.slice(i).join(' ');
      if (!rest) continue;
      if (!this.timezone && needsExplicitTimezone(candidate, 'in')) continue;
      const ts = parseReminderTime(candidate, 'in', this.timezone, now);
      if (ts === null) continue;
      if (!isReminderDuration(candidate) && !this._chronoCovers(candidate)) continue;
      return { ts, rest };
    }
    return {
      error:
        'Could not parse the time. Put the "when" first, e.g. `/reminder add in 20 minutes check the oven` or `/reminder add tomorrow 18hs call mom`. Absolute times need `timezone` in acp-connector.jsonc or an explicit offset like -03:00.',
    };
  }

  /**
   * True when the candidate is safe to treat as a complete "when".
   * Durations are anchored by regex and explicit-zone/ISO inputs bypass
   * chrono entirely — for those, an empty chrono result is fine. Only
   * chrono-parsed absolutes need full coverage, so a prefix like
   * "in 20 minutes revisar" can't match just "in 20 minutes".
   */
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

  private async _reminderAdd(restStr: string, chatId: number): Promise<boolean> {
    const mgr = this.reminderManager;
    if (!mgr) {
      await this.sendMessage(chatId, 'Reminders are not available on this bridge.');
      return true;
    }
    const parsed = this._parseWhenPrefix(restStr);
    if ('error' in parsed) {
      await this.sendMessage(chatId, parsed.error);
      return true;
    }
    try {
      const r = mgr.create(parsed.rest, parsed.ts, 'operator');
      await this.sendMessage(
        chatId,
        `✅ Reminder \`${r.id}\` set for ${formatFiresAt(r.firesAt, this.timezone)} — ${r.prompt.slice(0, 80)}`
      );
    } catch (err) {
      await this.sendMessage(chatId, `Failed to schedule reminder: ${(err as Error).message}`);
    }
    return true;
  }

  private async _reminderRemove(restStr: string, chatId: number): Promise<boolean> {
    const mgr = this.reminderManager;
    if (!mgr) {
      await this.sendMessage(chatId, 'Reminders are not available on this bridge.');
      return true;
    }
    const id = restStr.trim();
    if (!id) {
      await this.sendMessage(chatId, 'Usage: /reminder remove `<id>` — see /reminder list');
      return true;
    }
    if (!mgr.cancel(id)) {
      await this.sendMessage(chatId, `Reminder "${id}" not found.`);
      return true;
    }
    await this.sendMessage(chatId, `✅ Reminder \`${id}\` cancelled.`);
    return true;
  }

  private async _handleRun(args: string, chatId: number): Promise<boolean> {
    const name = args.trim();
    if (!name) {
      await this.sendMessage(chatId, 'Usage: /run `<name>`');
      return true;
    }
    const routine = this.routines.find((r) => r.name === name);
    if (!routine) {
      await this.sendMessage(
        chatId,
        `Routine "${name}" not found. Use /routine list to see available routines.`
      );
      return true;
    }
    log.info(`📝 routine "${name}" fired`);
    this.enqueue(routine.prompt, chatId);
    return true;
  }

  private _persist(): void {
    persistCronAndRoutines(this.cronManager.list(), this.routines);
  }
}
