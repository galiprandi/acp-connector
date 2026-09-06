import { loadConfig, saveConfig } from './config.js';

/**
 * @typedef {Object} Routine
 * @property {string} name
 * @property {string} prompt
 */

/**
 * Manages named reusable prompts and bridge commands.
 * Handles /cron, /routine, /run commands from Telegram.
 */
export class RoutineManager {
  /**
   * @param {Object} opts
   * @param {Routine[]} opts.routines
   * @param {import('./cron.js').CronManager} opts.cronManager
   * @param {Function} opts.enqueue - (text, chatId) => void
   * @param {Function} opts.sendMessage - (chatId, text) => Promise
   * @param {number[]} opts.allowedChatIds
   */
  constructor({ routines, cronManager, enqueue, sendMessage, allowedChatIds }) {
    this.routines = routines || [];
    this.cronManager = cronManager;
    this.enqueue = enqueue;
    this.sendMessage = sendMessage;
    this.allowedChatIds = allowedChatIds || [];
  }

  /**
   * Handle a bridge command from Telegram.
   * @param {string} text
   * @param {number} chatId
   * @returns {Promise<boolean>} - true if handled
   */
  async handleCommand(text, chatId) {
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

  async _handleCron(args, chatId) {
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

  async _cronList(chatId) {
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

  async _cronAdd(restStr, chatId) {
    // Format: <schedule: 5 tokens> <prompt>
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

  async _cronRemove(restStr, chatId) {
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

  async _cronToggle(restStr, chatId) {
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

  async _cronRun(restStr, chatId) {
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

  async _handleRoutine(args, chatId) {
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

  async _routineList(chatId) {
    if (this.routines.length === 0) {
      await this.sendMessage(chatId, 'No routines configured.');
      return true;
    }
    const lines = this.routines.map((r) => `\`${r.name}\` — ${r.prompt.slice(0, 60)}`);
    await this.sendMessage(chatId, `*Routines:*\n${lines.join('\n')}`);
    return true;
  }

  async _routineAdd(restStr, chatId) {
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

  async _routineRemove(restStr, chatId) {
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

  async _handleRun(args, chatId) {
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
    this.enqueue(routine.prompt, chatId);
    return true;
  }

  _persist() {
    const config = loadConfig();
    if (!config) return;
    config.routines = this.routines;
    config.cron = this.cronManager.list();
    saveConfig(config);
  }
}
