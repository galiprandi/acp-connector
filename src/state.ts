import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type BridgeConfig, defaultConfigPath, loadConfig, saveConfig } from './config.js';
import { log } from './logger.js';

/**
 * Unified runtime state for the bridge — `.acp-connector/state.json`.
 *
 * The two-file model: `acp-connector.jsonc` is user-owned config (truth),
 * `state.json` is everything the bridge learns/remembers at runtime:
 * active session id, chat aliases, scheduled jobs, A2A network peers.
 * Every feature that needs persistence goes through this store — no new
 * per-feature JSON files.
 *
 * Writes are atomic (tmp + rename), mode 0600. The whole file is small
 * (KBs) so write-through on every mutation is cheap and race-free inside
 * the single bridge process.
 */

export const STATE_VERSION = 1;

export interface BridgeState {
  version: number;
  /** Active ACP session id — auto-managed when restoreLastSession is on. */
  sessionId?: string;
  /** Chat alias directory entries (Agent-facing `Platform/Name` → chatId). */
  aliases?: unknown[];
  /** Scheduled/manual jobs (see jobs.ts). */
  jobs?: unknown[];
  /** A2A network state (see network.ts NetworkState). */
  network?: unknown;
}

export class StateStore {
  private data: BridgeState;
  private filePath: string;

  private constructor(filePath: string, data: BridgeState) {
    this.filePath = filePath;
    this.data = data;
  }

  /**
   * Load (or create) the state file. A corrupt file is renamed to
   * `.corrupt` and a fresh state is started — runtime state must never
   * kill the bridge (same policy as NetworkStore).
   */
  static load(filePath: string): StateStore {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as BridgeState;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return new StateStore(filePath, { ...parsed, version: STATE_VERSION });
        }
        throw new Error('state.json is not an object');
      } catch {
        renameSync(filePath, `${filePath}.corrupt`);
        log.warn(`state: could not parse ${filePath} — moved to .corrupt, starting fresh`);
      }
    }
    return new StateStore(filePath, { version: STATE_VERSION });
  }

  get<K extends keyof BridgeState>(key: K): BridgeState[K] {
    return this.data[key];
  }

  /** Set a section and persist immediately. */
  set<K extends keyof BridgeState>(key: K, value: BridgeState[K]): void {
    this.data[key] = value;
    this.save();
  }

  /** Mutate a section via callback, then persist. */
  update<K extends keyof BridgeState>(
    key: K,
    fn: (value: NonNullable<BridgeState[K]>) => void
  ): void {
    const current = (this.data[key] ?? []) as NonNullable<BridgeState[K]>;
    fn(current);
    this.data[key] = current;
    this.save();
  }

  save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, this.filePath);
      try {
        // tighten pre-existing files; creation mode covers new ones
        chmodSync(this.filePath, 0o600);
        chmodSync(dirname(this.filePath), 0o700);
      } catch {
        // best-effort
      }
    } catch (err) {
      log.warn(`state: could not persist ${this.filePath}: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function _migrateFile(stateDir: string, name: string): string | null {
  const path = `${stateDir}/${name}`;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    // Keep the legacy file as .migrated — rollback is a rename away.
    renameSync(path, `${path}.migrated`);
    return JSON.stringify(parsed);
  } catch (err) {
    log.warn(`state migration: could not read ${path}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * One-shot migration from the pre-state.json layout into the unified
 * store. Runs on every boot but is a no-op once done:
 *
 *   aliases.json      → state.aliases
 *   reminders.json    → state.jobs (kind "once")
 *   network.json      → state.network
 *   config.cron[]     → state.jobs (kind "cron")
 *   config.routines[] → state.jobs (kind "manual")
 *   config.sessionId  → state.sessionId
 *
 * Migrated legacy files are renamed `*.migrated`; migrated config fields
 * (cron/routines/sessionId) are stripped from acp-connector.jsonc.
 */
export function migrateLegacyState(
  store: StateStore,
  stateDir: string,
  config: BridgeConfig,
  configPath: string = defaultConfigPath
): void {
  let dirty = false;

  if (store.get('aliases') === undefined) {
    const raw = _migrateFile(stateDir, 'aliases.json');
    if (raw !== null) {
      try {
        store.set('aliases', JSON.parse(raw));
        dirty = true;
      } catch {
        // unparsable — already renamed, start clean
      }
    }
  }

  if (store.get('network') === undefined) {
    const raw = _migrateFile(stateDir, 'network.json');
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Tolerate a state.json-shaped file (envelope with .network).
        store.set(
          'network',
          (parsed.network && typeof parsed.network === 'object'
            ? parsed.network
            : parsed) as BridgeState['network']
        );
        dirty = true;
      } catch {
        // unparsable
      }
    }
  }

  // Jobs: merge reminders.json (once) + config.cron (cron) + config.routines (manual)
  if (store.get('jobs') === undefined) {
    const jobs: unknown[] = [];
    const remindersRaw = _migrateFile(stateDir, 'reminders.json');
    if (remindersRaw !== null) {
      try {
        const list = JSON.parse(remindersRaw) as Array<Record<string, unknown>>;
        if (Array.isArray(list)) {
          for (const r of list) {
            if (r && typeof r.id === 'string' && typeof r.prompt === 'string' && r.firesAt) {
              jobs.push({
                id: r.id,
                prompt: r.prompt,
                trigger: { kind: 'once', at: r.firesAt },
                enabled: true,
                managed: r.managed === 'operator' ? 'operator' : 'agent',
                createdAt: r.createdAt ?? new Date().toISOString(),
              });
            }
          }
        }
      } catch {
        // unparsable
      }
    }
    for (const c of config.cron ?? []) {
      jobs.push({
        id: `mig-${Date.now().toString(36)}-${jobs.length}`,
        name: c.name,
        prompt: c.prompt,
        trigger: { kind: 'cron', expr: c.schedule },
        enabled: c.enabled !== false,
        managed: c.managed === 'agent' ? 'agent' : 'operator',
        chatId: c.chatId,
        createdAt: new Date().toISOString(),
      });
    }
    for (const r of config.routines ?? []) {
      jobs.push({
        id: `mig-${Date.now().toString(36)}-${jobs.length}`,
        name: r.name,
        prompt: r.prompt,
        trigger: { kind: 'manual' },
        enabled: true,
        managed: 'operator',
        createdAt: new Date().toISOString(),
      });
    }
    if (jobs.length > 0 || remindersRaw !== null) {
      store.set('jobs', jobs);
      dirty = true;
    }
  }

  if (store.get('sessionId') === undefined && config.sessionId) {
    store.set('sessionId', config.sessionId);
    dirty = true;
  }

  // Strip migrated fields from the config file so they are not read again.
  if (config.cron || config.routines || config.sessionId) {
    try {
      const fresh = loadConfig(configPath) ?? config;
      delete fresh.cron;
      delete fresh.routines;
      delete fresh.sessionId;
      saveConfig(fresh, configPath);
      dirty = true;
    } catch (err) {
      log.warn(`state migration: could not strip legacy config fields: ${(err as Error).message}`);
    }
  }

  if (dirty) log.info('🔄 migrated legacy state files into .acp-connector/state.json');
}
