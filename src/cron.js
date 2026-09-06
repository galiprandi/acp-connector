import cron from 'node-cron';

/**
 * @typedef {Object} CronJob
 * @property {string} name
 * @property {string} schedule
 * @property {string} prompt
 * @property {number} [chatId]
 * @property {boolean} [enabled]
 */

/**
 * Manages scheduled prompt injection into the bridge queue.
 */
export class CronManager {
  /**
   * @param {Object} opts
   * @param {CronJob[]} opts.jobs
   * @param {number[]} opts.allowedChatIds
   * @param {Function} opts.enqueue - (text, chatId) => void
   * @param {Function} [opts.onLog]
   */
  constructor({ jobs, allowedChatIds, enqueue, onLog = null }) {
    this.jobs = jobs || [];
    this.allowedChatIds = allowedChatIds || [];
    this.enqueue = enqueue;
    this.onLog = onLog || ((msg) => console.log(msg));
    this._tasks = new Map();
  }

  start() {
    for (const job of this.jobs) {
      this._startJob(job);
    }
  }

  _startJob(job) {
    if (job.enabled === false) {
      this.onLog(`⏰ cron "${job.name}" disabled, skipping`);
      return;
    }

    if (!job.prompt) {
      this.onLog(`⏰ cron "${job.name}" empty prompt, skipping`);
      return;
    }

    if (!cron.validate(job.schedule)) {
      this.onLog(`⏰ cron "${job.name}" invalid schedule: ${job.schedule}`);
      return;
    }

    const chatId = job.chatId || this.allowedChatIds[0];
    if (!chatId) {
      this.onLog(`⏰ cron "${job.name}" no chatId and no allowedChatIds`);
      return;
    }

    const task = cron.schedule(job.schedule, () => {
      this.onLog(`⏰ cron "${job.name}" fired`);
      this.enqueue(job.prompt, chatId);
    });

    this._tasks.set(job.name, { task, job });
    this.onLog(`⏰ cron "${job.name}" scheduled: ${job.schedule}`);
  }

  /**
   * Add a new job, start it, and return it.
   * @param {CronJob} job
   * @returns {CronJob | null}
   */
  add(job) {
    if (this._tasks.has(job.name)) {
      this.onLog(`⏰ cron "${job.name}" already exists`);
      return null;
    }
    this.jobs.push(job);
    this._startJob(job);
    return job;
  }

  /**
   * Remove a job by name and stop it.
   * @param {string} name
   * @returns {boolean}
   */
  remove(name) {
    const entry = this._tasks.get(name);
    if (entry) {
      entry.task.stop();
      this._tasks.delete(name);
    }
    const idx = this.jobs.findIndex((j) => j.name === name);
    if (idx >= 0) {
      this.jobs.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Toggle a job's enabled state.
   * @param {string} name
   * @returns {boolean} - new enabled state
   */
  toggle(name) {
    const idx = this.jobs.findIndex((j) => j.name === name);
    if (idx < 0) return false;

    const job = this.jobs[idx];
    const newEnabled = job.enabled === false;
    job.enabled = newEnabled;

    const entry = this._tasks.get(name);
    if (entry) {
      entry.task.stop();
      this._tasks.delete(name);
    }

    if (newEnabled) {
      this._startJob(job);
    }

    return newEnabled;
  }

  /**
   * Run a job immediately.
   * @param {string} name
   * @returns {boolean}
   */
  run(name) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return false;

    const chatId = job.chatId || this.allowedChatIds[0];
    if (!chatId) return false;

    this.onLog(`⏰ cron "${job.name}" manual run`);
    this.enqueue(job.prompt, chatId);
    return true;
  }

  /**
   * Get all jobs.
   * @returns {CronJob[]}
   */
  list() {
    return [...this.jobs];
  }

  stop() {
    for (const { task } of this._tasks.values()) {
      task.stop();
    }
    this._tasks.clear();
  }
}
