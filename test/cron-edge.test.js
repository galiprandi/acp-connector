import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTask = {
  stop: vi.fn(),
};

const mockValidate = vi.fn(() => true);
const mockSchedule = vi.fn(() => mockTask);

vi.mock('node-cron', () => ({
  default: {
    validate: mockValidate,
    schedule: mockSchedule,
  },
}));

const { CronManager } = await import('../src/cron.ts');

function createManager(jobs = [], overrides = {}) {
  const enqueue = vi.fn();
  const onLog = vi.fn();
  const manager = new CronManager({
    jobs,
    allowedChatIds: [123],
    enqueue,
    onLog,
    ...overrides,
  });
  return { manager, enqueue, onLog };
}

describe('CronManager edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
  });

  it('skips job with invalid cron expression', () => {
    mockValidate.mockReturnValue(false);
    const { manager, onLog } = createManager([
      { name: 'bad', schedule: 'not a cron', prompt: 'hi' },
    ]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('invalid schedule'));
  });

  it('skips job with empty prompt', () => {
    const { manager, onLog } = createManager([
      { name: 'empty', schedule: '0 9 * * *', prompt: '' },
    ]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('empty prompt'));
  });

  it('skips job with empty schedule', () => {
    mockValidate.mockReturnValue(false);
    const { manager, onLog } = createManager([{ name: 'empty-sched', schedule: '', prompt: 'hi' }]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('invalid schedule'));
  });

  it('add() rejects duplicate name and does not push a second job', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hi' }]);
    manager.start();
    const result = manager.add({ name: 'job1', schedule: '0 10 * * *', prompt: 'world' });
    expect(result).toBeNull();
    expect(manager.jobs.filter((j) => j.name === 'job1')).toHaveLength(1);
  });

  it('remove() returns false for non-existent job', () => {
    const { manager } = createManager([]);
    expect(manager.remove('nonexistent')).toBe(false);
  });

  it('toggle() returns false for non-existent job', () => {
    const { manager } = createManager([]);
    expect(manager.toggle('nonexistent')).toBe(false);
  });

  it('run() returns false for non-existent job', () => {
    const { manager } = createManager([]);
    expect(manager.run('nonexistent')).toBe(false);
  });

  it('skips job with no chatId when allowedChatIds is empty', () => {
    const { manager, onLog } = createManager(
      [{ name: 'nochat', schedule: '0 9 * * *', prompt: 'hi' }],
      { allowedChatIds: [] }
    );
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('no chatId'));
  });

  it('start() with empty jobs array is a no-op', () => {
    const { manager } = createManager([]);
    manager.start();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('stop() when no jobs running is a no-op', () => {
    const { manager } = createManager([]);
    manager.start();
    expect(() => manager.stop()).not.toThrow();
  });

  it('add() after stop() starts the new job', () => {
    const { manager } = createManager([{ name: 'job1', schedule: '0 9 * * *', prompt: 'hi' }]);
    manager.start();
    manager.stop();
    mockSchedule.mockClear();
    const job = manager.add({ name: 'job2', schedule: '0 10 * * *', prompt: 'world' });
    expect(job).not.toBeNull();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('multiple jobs with same schedule all start', () => {
    const { manager } = createManager([
      { name: 'a', schedule: '0 9 * * *', prompt: 'a' },
      { name: 'b', schedule: '0 9 * * *', prompt: 'b' },
    ]);
    manager.start();
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });
});
