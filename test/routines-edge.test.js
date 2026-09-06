import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadConfig = vi.fn(() => ({ routines: [], cron: [] }));
const mockSaveConfig = vi.fn();

vi.mock('../src/config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (...args) => mockSaveConfig(...args),
}));

const { RoutineManager } = await import('../src/routines.js');

function createManager(overrides = {}) {
  const enqueue = vi.fn();
  const sendMessage = vi.fn(async () => ({}));
  const cronManager = {
    list: vi.fn(() => []),
    add: vi.fn((job) => job),
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

describe('RoutineManager edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ routines: [], cron: [] });
  });

  it('/cron add with 4-token schedule fails (needs 5)', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron add 0 9 * * briefing', 123);
    expect(cronManager.add).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/cron add with no prompt (only 5 tokens) fails', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron add 0 9 * * *', 123);
    expect(cronManager.add).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/cron add with no schedule (empty) fails', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron add', 123);
    expect(cronManager.add).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/run with empty name shows usage', async () => {
    const { manager, enqueue, sendMessage } = createManager();
    await manager.handleCommand('/run', 123);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/routine add with no name shows usage', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine add', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/routine add with no prompt shows usage', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine add briefing', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/routine add with duplicate name rejects', async () => {
    const { manager, sendMessage } = createManager({
      routines: [{ name: 'briefing', prompt: 'old' }],
    });
    await manager.handleCommand('/routine add briefing new prompt', 123);
    expect(manager.routines).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('already exists'));
  });

  it('/cron remove with empty name shows usage', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron remove', 123);
    expect(cronManager.remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/cron toggle with empty name shows usage', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron toggle', 123);
    expect(cronManager.toggle).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/cron run with empty name shows usage', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron run', 123);
    expect(cronManager.run).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('_persist does nothing when loadConfig returns null', async () => {
    mockLoadConfig.mockReturnValue(null);
    const { manager } = createManager();
    await manager.handleCommand('/cron add 0 9 * * * do the briefing', 123);
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('/routine remove with empty name shows usage', async () => {
    const { manager, sendMessage } = createManager();
    await manager.handleCommand('/routine remove', 123);
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Usage'));
  });

  it('/cron add with multi-word prompt works', async () => {
    const { manager, cronManager, sendMessage } = createManager();
    await manager.handleCommand('/cron add 0 9 * * * do the morning briefing', 123);
    expect(cronManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: '0 9 * * *',
        prompt: 'do the morning briefing',
      })
    );
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('✅'));
  });
});
