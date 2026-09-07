import cron, { type ScheduledTask } from 'node-cron';

/**
 * A scheduled prompt injection job.
 */
export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  chatId?: number | string;
  enabled?: boolean;
}

/**
 * Logger callback used by CronManager.
 */
type LogFn = (msg: string) => void;

/**
 * Enqueue callback: enqueues a prompt text for a given chat id.
 */
type EnqueueFn = (text: string, chatId: number | string) => void;

/**
 * Constructor options for CronManager.
 */
export interface CronManagerOptions {
  jobs: CronJob[];
  allowedChatIds: Array<number | string>;
  enqueue: EnqueueFn;
  onLog?: LogFn | null;
}

interface CronTaskEntry {
  task: ScheduledTask;
  job: CronJob;
}

/**
 * Manages scheduled prompt injection into the bridge queue.
 */
export class CronManager {
  jobs: CronJob[];
  allowedChatIds: Array<number | string>;
  enqueue: EnqueueFn;
  onLog: LogFn;
  private _tasks: Map<string, CronTaskEntry>;

  /**
   * @param opts jobs, allowedChatIds, enqueue, and optional onLog.
   */
  constructor({ jobs, allowedChatIds, enqueue, onLog = null }: CronManagerOptions) {
    this.jobs = jobs || [];
    this.allowedChatIds = allowedChatIds || [];
    this.enqueue = enqueue;
    this.onLog = onLog || ((msg) => console.log(msg));
    this._tasks = new Map();
  }

  start(): void {
    for (const job of this.jobs) {
      this._startJob(job);
    }
  }

  private _startJob(job: CronJob): void {
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
   * @returns the added job, or null if a job with the same name already exists.
   */
  add(job: CronJob): CronJob | null {
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
   * @returns true if the job was found and removed, false otherwise.
   */
  remove(name: string): boolean {
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
   * @returns the new enabled state, or false if the job was not found.
   */
  toggle(name: string): boolean {
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
   * @returns true if the job was found and run, false otherwise.
   */
  run(name: string): boolean {
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
   */
  list(): CronJob[] {
    return [...this.jobs];
  }

  stop(): void {
    for (const { task } of this._tasks.values()) {
      task.stop();
    }
    this._tasks.clear();
  }
}
