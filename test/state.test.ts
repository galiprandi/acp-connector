import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import { migrateLegacyState, STATE_VERSION, StateStore } from '../src/state.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-state-'));
  path = join(dir, 'state.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('creates a fresh versioned state when the file does not exist', () => {
    const store = StateStore.load(path);
    expect(store.get('version')).toBe(STATE_VERSION);
    expect(store.get('jobs')).toBeUndefined();
    expect(existsSync(path)).toBe(false); // nothing persisted until a set
  });

  it('persists sections atomically and reloads them', () => {
    const s1 = StateStore.load(path);
    s1.set('sessionId', 'sess-123');
    s1.set('aliases', [{ alias: 'Telegram/Familia', chatId: '1' }]);
    s1.set('jobs', [{ id: 'j1', prompt: 'x' }]);

    const s2 = StateStore.load(path);
    expect(s2.get('sessionId')).toBe('sess-123');
    expect(s2.get('aliases')).toHaveLength(1);
    expect(s2.get('jobs')).toHaveLength(1);
    expect(s2.get('version')).toBe(STATE_VERSION);
  });

  it('supports namespaced update()', () => {
    const store = StateStore.load(path);
    store.set('jobs', [{ id: 'a' }]);
    store.update('jobs', (jobs) => {
      (jobs as Array<{ id: string }>).push({ id: 'b' });
    });
    const reloaded = StateStore.load(path);
    expect((reloaded.get('jobs') as Array<{ id: string }>).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('writes the file with owner-only permissions', () => {
    const nested = join(dir, 'deep', 'state.json');
    const store = StateStore.load(nested);
    store.set('sessionId', 'x');
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'deep')).mode & 0o777).toBe(0o700);
    chmodSync(nested, 0o644);
    store.set('sessionId', 'y');
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });

  it('renames a corrupt state file to .corrupt and starts fresh', () => {
    writeFileSync(path, '{not json');
    const store = StateStore.load(path);
    expect(store.get('version')).toBe(STATE_VERSION);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('ignores a non-object state file', () => {
    writeFileSync(path, '[1,2,3]');
    const store = StateStore.load(path);
    expect(store.get('version')).toBe(STATE_VERSION);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });
});

describe('migrateLegacyState', () => {
  const baseConfig = (over: Partial<BridgeConfig> = {}): BridgeConfig =>
    ({ agentCmd: 'devin acp', ...over }) as BridgeConfig;

  it('is a no-op when there is nothing to migrate', () => {
    const store = StateStore.load(path);
    migrateLegacyState(store, dir, baseConfig(), join(dir, 'acp-connector.jsonc'));
    expect(store.get('aliases')).toBeUndefined();
    expect(store.get('jobs')).toBeUndefined();
    expect(store.get('sessionId')).toBeUndefined();
  });

  it('imports aliases.json and renames it .migrated', () => {
    writeFileSync(
      join(dir, 'aliases.json'),
      JSON.stringify([{ alias: 'Telegram/Familia', chatId: '42', platform: 'telegram' }])
    );
    const store = StateStore.load(path);
    migrateLegacyState(store, dir, baseConfig(), join(dir, 'acp-connector.jsonc'));
    expect(store.get('aliases')).toHaveLength(1);
    expect(existsSync(join(dir, 'aliases.json.migrated'))).toBe(true);
    expect(existsSync(join(dir, 'aliases.json'))).toBe(false);
  });

  it('imports network.json into the network section', () => {
    const network = {
      schemaVersion: 1,
      role: 'peer',
      peers: [{ id: 'lean', status: 'approved' }],
      seenTaskIds: ['t1'],
    };
    writeFileSync(join(dir, 'network.json'), JSON.stringify(network));
    const store = StateStore.load(path);
    migrateLegacyState(store, dir, baseConfig(), join(dir, 'acp-connector.jsonc'));
    expect(store.get('network')).toEqual(network);
    expect(existsSync(join(dir, 'network.json.migrated'))).toBe(true);
  });

  it('imports pending reminders as once jobs', () => {
    writeFileSync(
      join(dir, 'reminders.json'),
      JSON.stringify([
        {
          id: 'r1',
          prompt: 'check the oven',
          firesAt: '2030-01-01T12:00:00.000Z',
          managed: 'operator',
          createdAt: '2029-12-01T00:00:00.000Z',
        },
        {
          id: 'r2',
          prompt: 'agent ping',
          firesAt: '2030-01-02T12:00:00.000Z',
          managed: 'agent',
          createdAt: '2029-12-01T00:00:00.000Z',
        },
      ])
    );
    const store = StateStore.load(path);
    migrateLegacyState(store, dir, baseConfig(), join(dir, 'acp-connector.jsonc'));
    const jobs = store.get('jobs') as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.id).toBe('r1');
    expect(jobs[0]?.trigger).toEqual({ kind: 'once', at: '2030-01-01T12:00:00.000Z' });
    expect(jobs[1]?.managed).toBe('agent');
    expect(existsSync(join(dir, 'reminders.json.migrated'))).toBe(true);
  });

  it('imports config.cron as cron jobs and config.routines as manual jobs', () => {
    const store = StateStore.load(path);
    migrateLegacyState(
      store,
      dir,
      baseConfig({
        cron: [
          {
            name: 'logs',
            schedule: '0 * * * *',
            prompt: 'check logs',
            enabled: true,
            managed: 'operator',
          },
        ],
        routines: [{ name: 'deploy', prompt: 'run the deploy checklist' }],
      }),
      join(dir, 'acp-connector.jsonc')
    );
    const jobs = store.get('jobs') as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.trigger).toEqual({ kind: 'cron', expr: '0 * * * *' });
    expect(jobs[0]?.name).toBe('logs');
    expect(jobs[1]?.trigger).toEqual({ kind: 'manual' });
    expect(jobs[1]?.name).toBe('deploy');
  });

  it('imports config.sessionId into state', () => {
    const store = StateStore.load(path);
    migrateLegacyState(
      store,
      dir,
      baseConfig({ sessionId: 'sess-abc' }),
      join(dir, 'acp-connector.jsonc')
    );
    expect(store.get('sessionId')).toBe('sess-abc');
  });

  it('does not clobber existing state sections', () => {
    writeFileSync(join(dir, 'aliases.json'), JSON.stringify([{ alias: 'X', chatId: '1' }]));
    const store = StateStore.load(path);
    store.set('aliases', [{ alias: 'Already', chatId: '9' }]);
    migrateLegacyState(store, dir, baseConfig(), join(dir, 'acp-connector.jsonc'));
    expect((store.get('aliases') as Array<{ alias: string }>)[0]?.alias).toBe('Already');
    // legacy file still migrated away (it was consumed-or-ignored)
    expect(existsSync(join(dir, 'aliases.json.migrated'))).toBe(false); // untouched: section existed
  });

  it('is idempotent — second run changes nothing', () => {
    writeFileSync(join(dir, 'aliases.json'), JSON.stringify([{ alias: 'X', chatId: '1' }]));
    const store = StateStore.load(path);
    migrateLegacyState(
      store,
      dir,
      baseConfig({ sessionId: 's1' }),
      join(dir, 'acp-connector.jsonc')
    );
    const jobsAfter = store.get('jobs');
    migrateLegacyState(
      store,
      dir,
      baseConfig({ sessionId: 's1' }),
      join(dir, 'acp-connector.jsonc')
    );
    expect(store.get('sessionId')).toBe('s1');
    expect(store.get('jobs')).toEqual(jobsAfter);
    expect(store.get('aliases')).toHaveLength(1);
  });
});
