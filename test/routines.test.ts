import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const { ReminderManager } = await import('../src/reminders.js');

interface MockCronManager {
  list: vi.Mock;
  add: vi.Mock;
  remove: vi.Mock;
  toggle: vi.Mock;
  run: vi.Mock;
}

interface CreateManagerOverrides {
  routines?: Routine[];
  reminderManager?: InstanceType<typeof ReminderManager>;
  timezone?: string;
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

  describe('/reminder', () => {
    let remDir: string;
    let reminderManager: InstanceType<typeof ReminderManager>;

    beforeEach(() => {
      remDir = mkdtempSync(join(tmpdir(), 'acp-routines-rem-'));
      reminderManager = new ReminderManager({
        storePath: join(remDir, 'reminders.json'),
        canDeliver: () => false,
        deliver: vi.fn(),
        onLog: () => {},
      });
    });

    afterEach(() => {
      reminderManager.stop();
      rmSync(remDir, { recursive: true, force: true });
    });

    function withReminders(timezone?: string) {
      return createManager({ reminderManager, timezone });
    }

    it('says unavailable without a reminder manager', async () => {
      const { manager, sendMessage } = createManager();
      await manager.handleCommand('/reminder list', 123);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('not available'));
    });

    it('lists empty and populated reminders with owner badges', async () => {
      const { manager, sendMessage } = withReminders('UTC');
      await manager.handleCommand('/reminder list', 123);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('No reminders'));

      reminderManager.create('agent task', Date.now() + 60_000);
      reminderManager.create('operator task', Date.now() + 120_000, 'operator');
      await manager.handleCommand('/reminder list', 123);
      const msg = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(msg).toContain('🤖');
      expect(msg).toContain('👤');
      expect(msg).toContain('GMT');
    });

    it('adds a duration reminder and confirms with local time + zone', async () => {
      const { manager, sendMessage } = withReminders('America/Argentina/Buenos_Aires');
      await manager.handleCommand('/reminder add in 20 minutes check the oven', 123);
      expect(reminderManager.list()).toHaveLength(1);
      const r = reminderManager.list()[0];
      expect(r.prompt).toBe('check the oven');
      expect(r.managed).toBe('operator');
      const msg = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(msg).toContain('✅');
      expect(msg).toContain('GMT-3');
      expect(msg).toContain('America/Argentina/Buenos_Aires');
    });

    it('adds an absolute reminder using config.timezone', async () => {
      const { manager } = withReminders('America/Argentina/Tucuman');
      await manager.handleCommand('/reminder add tomorrow 6pm call mom', 123);
      const r = reminderManager.list()[0];
      expect(r.prompt).toBe('call mom');
      // 18:00 in UTC-3 → 21:00 UTC
      expect(Date.parse(r.firesAt)).toBeGreaterThan(Date.now());
    });

    it('rejects naive absolute times without config.timezone', async () => {
      const { manager, sendMessage } = withReminders();
      await manager.handleCommand('/reminder add tomorrow 6pm call mom', 123);
      expect(reminderManager.list()).toHaveLength(0);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Could not parse'));
    });

    it('rejects input with no parseable time', async () => {
      const { manager, sendMessage } = withReminders('UTC');
      await manager.handleCommand('/reminder add check the oven', 123);
      expect(reminderManager.list()).toHaveLength(0);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Could not parse'));
    });

    it('does not let a partial chrono match steal prompt words', async () => {
      const { manager } = withReminders('UTC');
      await manager.handleCommand('/reminder add in 20 minutes revisar el horno', 123);
      const r = reminderManager.list()[0];
      expect(r.prompt).toBe('revisar el horno');
    });

    it('removes reminders by id', async () => {
      const { manager, sendMessage } = withReminders('UTC');
      reminderManager.create('task', Date.now() + 60_000, 'operator');
      const id = reminderManager.list()[0].id;
      await manager.handleCommand(`/reminder remove ${id}`, 123);
      expect(reminderManager.list()).toHaveLength(0);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('cancelled'));
      await manager.handleCommand('/reminder remove nope', 123);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('not found'));
    });

    it('shows help for bare /reminder', async () => {
      const { manager, sendMessage } = withReminders();
      await manager.handleCommand('/reminder', 123);
      expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Reminder commands'));
    });
  });
});
