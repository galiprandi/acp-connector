import type { Routine } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import type { CronManager } from './cron.js';

interface RoutineManagerOpts {
  routines: Routine[];
  cronManager: CronManager;
  enqueue: (text: string, chatId?: number) => void;
  sendMessage: (chatId: number, text: string) => Promise<void>;
}

export class RoutineManager {
  private routines: Routine[];
  private cronManager: CronManager;
  private enqueue: (text: string, chatId?: number) => void;
  private sendMessage: (chatId: number, text: string) => Promise<void>;

  constructor({ routines, cronManager, enqueue, sendMessage }: RoutineManagerOpts) {
    this.routines = routines || [];
    this.cronManager = cronManager;
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
    console.log(`📝 routine "${name}" fired`);
    this.enqueue(routine.prompt, chatId);
    return true;
  }

  private _persist(): void {
    const config = loadConfig();
    if (!config) return;
    config.routines = this.routines;
    config.cron = this.cronManager.list();
    saveConfig(config);
  }
}
