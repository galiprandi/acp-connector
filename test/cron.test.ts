import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob, CronManagerOptions } from '../src/cron';

const mockTask: { stop: vi.Mock } = {
  stop: vi.fn(),
};

const mockValidate: vi.Mock = vi.fn(() => true);
const mockSchedule: vi.Mock = vi.fn(() => mockTask);

vi.mock('node-cron', () => ({
  default: {
    validate: mockValidate,
    schedule: mockSchedule,
  },
}));

const { CronManager } = await import('../src/cron.ts');

interface CreateManagerResult {
  // biome-ignore lint/suspicious/noExplicitAny: CronManager constructor type is complex in mock context
  manager: any;
  enqueue: vi.Mock;
  onLog: vi.Mock;
}

function createManager(
  jobs: CronJob[] = [],
  overrides: Partial<CronManagerOptions> = {}
): CreateManagerResult {
  const enqueue: vi.Mock = vi.fn();
  const onLog: vi.Mock = vi.fn();
  const manager = new CronManager({
    jobs,
    allowedChatIds: [123],
    enqueue,
    onLog,
    ...overrides,
  });
  return { manager, enqueue, onLog };
}

describe('CronManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
  });

  it('starts all valid jobs', () => {
    const { manager, onLog } = createManager([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello' },
      { name: 'job2', schedule: '0 10 * * *', prompt: 'world' },
    ]);
    manager.start();
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('job1'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('job2'));
  });

  it('skips disabled jobs', () => {
    const { manager, onLog } = createManager([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello', enabled: false },
    ]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('skips invalid schedules', () => {
    mockValidate.mockReturnValue(false);
    const { manager, onLog } = createManager([
      { name: 'job1', schedule: 'invalid', prompt: 'hello' },
    ]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('invalid schedule'));
  });

  it('skips jobs with no chatId when allowedChatIds is empty', () => {
    const { manager, onLog } = createManager(
      [{ name: 'job1', schedule: '0 9 * * *', prompt: 'hello' }],
      { allowedChatIds: [] }
    );
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('no chatId'));
  });

  it('fires job and enqueues prompt', () => {
    const { manager, enqueue } = createManager([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello' },
    ]);
    manager.start();
    const callback = mockSchedule.mock.calls[0][1] as () => void;
    callback();
    expect(enqueue).toHaveBeenCalledWith('hello', 123);
  });

  it('uses job chatId when provided', () => {
    const { manager, enqueue } = createManager([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello', chatId: 999 },
    ]);
    manager.start();
    const callback = mockSchedule.mock.calls[0][1] as () => void;
    callback();
    expect(enqueue).toHaveBeenCalledWith('hello', 999);
  });

  it('add() starts a new job', () => {
    const { manager, onLog } = createManager([]);
    manager.start();
    const job = manager.add({ name: 'newjob', schedule: '0 9 * * *', prompt: 'test' });
    expect(job).not.toBeNull();
    expect(mockSchedule).toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('newjob'));
  });

  it('add() rejects duplicate name', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hello' }]);
    manager.start();
    const result = manager.add({ name: 'job1', schedule: '0 10 * * *', prompt: 'world' });
    expect(result).toBeNull();
  });

  it('remove() stops and removes job', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hello' }]);
    manager.start();
    const result = manager.remove('job1');
    expect(result).toBe(true);
    expect(mockTask.stop).toHaveBeenCalled();
    expect(manager.list()).toHaveLength(0);
  });

  it('remove() returns false for unknown job', () => {
    const { manager } = createManager([]);
    expect(manager.remove('nonexistent')).toBe(false);
  });

  it('toggle() pauses and activates', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hello' }]);
    manager.start();
    const newState = manager.toggle('job1');
    expect(newState).toBe(false);
    const newState2 = manager.toggle('job1');
    expect(newState2).toBe(true);
  });

  it('run() executes job immediately', () => {
    const { manager, enqueue } = createManager([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello' },
    ]);
    manager.start();
    const result = manager.run('job1');
    expect(result).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('hello', 123);
  });

  it('run() returns false for unknown job', () => {
    const { manager } = createManager([]);
    expect(manager.run('nonexistent')).toBe(false);
  });

  it('list() returns all jobs', () => {
    const jobs: CronJob[] = [
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello' },
      { name: 'job2', schedule: '0 10 * * *', prompt: 'world' },
    ];
    const { manager } = createManager(jobs);
    expect(manager.list()).toEqual(jobs);
  });

  it('stop() stops all tasks', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hello' }]);
    manager.start();
    manager.stop();
    expect(mockTask.stop).toHaveBeenCalled();
  });
});
