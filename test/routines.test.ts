import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Routine } from '../src/config';

const tmpConfigPath: string = resolve(process.cwd(), 'acp-connector.jsonc');

const mockLoadConfig: vi.Mock = vi.fn(() => ({ routines: [], cron: [] }));
const mockSaveConfig: vi.Mock = vi.fn();

vi.mock('../src/config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

const { RoutineManager } = await import('../src/routines.js');

interface MockCronManager {
  list: vi.Mock;
  add: vi.Mock;
  remove: vi.Mock;
  toggle: vi.Mock;
  run: vi.Mock;
}

interface CreateManagerOverrides {
  routines?: Routine[];
}

interface CreateManagerResult {
  // biome-ignore lint/suspicious/noExplicitAny: RoutineManager has private fields accessed in tests
  manager: any;
  enqueue: vi.Mock;
  sendMessage: vi.Mock;
  cronManager: MockCronManager;
}

function createManager(overrides: CreateManagerOverrides = {}): CreateManagerResult {
  const enqueue: vi.Mock = vi.fn();
  const sendMessage: vi.Mock = vi.fn(async () => ({}));
  const cronManager: MockCronManager = {
    list: vi.fn(() => []),
    add: vi.fn((job: unknown) => job),
    remove: vi.fn(() => true),
    toggle: vi.fn(() => true),
    run: vi.fn(() => true),
  };
  const manager = new RoutineManager({
    routines: [],
    cronManager,
    enqueue,
    sendMessage,
    allowedChatIds: [123],
    ...overrides,
  });
  return { manager, enqueue, sendMessage, cronManager };
}

describe('RoutineManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ routines: [], cron: [] });
  });

  afterEach(() => {
    if (existsSync(tmpConfigPath)) rmSync(tmpConfigPath);
  });

  it('returns false for non-command text', async () => {
    const { manager } = createManager();
    expect(await manager.handleCommand('hello', 123)).toBe(false);
  });

  it('returns false for unknown command', async () => {
    const { manager } = createManager();
    expect(await manager.handleCommand('/unknown', 123)).toBe(false);
  });

  it('/run executes routine by name', async () => {
    const { manager, enqueue } = createManager({
      routines: [{ name: 'briefing', prompt: 'do the briefing' }],
    });
    const result = await manager.handleCommand('/run briefing', 123);
    expect(result).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('do the briefing', 123);
  });

  it('/run with unknown name returns error', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/run nonexistent', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('not found'));
  });

  it('/run with no args shows usage', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/run', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/routine list shows all routines', async () => {
    const { manager, sendMessage } = createManager({
      routines: [
        { name: 'briefing', prompt: 'do the briefing' },
        { name: 'review', prompt: 'do the review' },
      ],
    });
    await manager.handleCommand('/routine list', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('briefing'));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('review'));
  });

  it('/routine list shows empty message when no routines', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine list', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('No routines'));
  });

  it('/routine add creates and persists', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine add briefing do the briefing', 123);
    expect(manager.routines).toHaveLength(1);
    expect(manager.routines[0].name).toBe('briefing');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('✅'));
  });

  it('/routine add rejects duplicate name', async () => {
    const { manager, sendMessage } = createManager({
      routines: [{ name: 'briefing', prompt: 'old' }],
    });
    await manager.handleCommand('/routine add briefing new prompt', 123);
    expect(manager.routines).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('already exists'));
  });

  it('/routine remove deletes and persists', async () => {
    const { manager, sendMessage } = createManager({
      routines: [{ name: 'briefing', prompt: 'do the briefing' }],
    });
    await manager.handleCommand('/routine remove briefing', 123);
    expect(manager.routines).toHaveLength(0);
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('✅'));
  });

  it('/routine remove with unknown name returns error', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine remove nonexistent', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('not found'));
  });

  it('/cron list shows all jobs', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    cronManager.list.mockReturnValue([
      { name: 'job1', schedule: '0 9 * * *', prompt: 'hello', enabled: true },
    ]);
    await manager.handleCommand('/cron list', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('job1'));
  });

  it('/cron add creates job and persists', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron add 0 9 * * * do the briefing', 123);
    expect(cronManager.add).toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('✅'));
  });

  it('/cron remove stops job and persists', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron remove job1', 123);
    expect(cronManager.remove).toHaveBeenCalledWith('job1');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('✅'));
  });

  it('/cron toggle toggles and persists', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    cronManager.toggle.mockReturnValue(true);
    await manager.handleCommand('/cron toggle job1', 123);
    expect(cronManager.toggle).toHaveBeenCalledWith('job1');
    expect(mockSaveConfig).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('activated'));
  });

  it('/cron run executes job immediately', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron run job1', 123);
    expect(cronManager.run).toHaveBeenCalledWith('job1');
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Running'));
  });

  it('/cron with no subcommand shows help', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/cron', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Cron commands'));
  });

  it('/routine with no subcommand shows help', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Routine commands'));
  });
});
