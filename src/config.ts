import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type LogLevel, log } from './logger.js';

export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  chatId?: number | string;
  enabled?: boolean;
}

export interface Routine {
  name: string;
  prompt: string;
}

export interface HttpConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  auth?: {
    token?: string;
  };
  forwardHeaders?: boolean;
  maxBodySize?: number;
  rateLimit?: number;
}

export interface MediaConfig {
  uploadsDir?: string;
}

export interface A2aSkill {
  id: string;
  name?: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface A2aCardConfig {
  name: string;
  description: string;
  version?: string;
  provider?: { organization?: string; url?: string };
  skills?: A2aSkill[];
  policies?: { requiresApproval?: string[] };
  securitySchemes?: Record<string, unknown>;
}

export interface A2aConfig {
  enabled?: boolean;
  /** Port for the A2A JSON-RPC endpoint (default 7741). */
  port?: number;
  /** Bind address (default 127.0.0.1). Use 0.0.0.0 for LAN/container exposure. */
  host?: string;
  /** Stable agent id used in peer lists and delegation chains (default: card.name lowercased). */
  id?: string;
  /** Agent Card fields served at /.well-known/agent-card.json. */
  card?: A2aCardConfig;
  /** Explicit registry URL for curated-registry discovery. */
  registry?: string;
  /** Declaratively trusted peer ids. */
  trustedPeers?: string[];
  /** Act as a network registry (directory only, never sees task content). */
  registryMode?: boolean;
}

export interface TelegramPlatformConfig {
  token: string;
  allowedChatIds: number[];
}

export interface DiscordPlatformConfig {
  token: string;
  allowedChannelIds: string[];
}

export interface PlatformsConfig {
  telegram?: TelegramPlatformConfig;
  discord?: DiscordPlatformConfig;
}

export interface BridgeConfig {
  agentCmd: string;
  agentCwd?: string;
  /** @deprecated use platforms.telegram.token */
  telegramToken?: string;
  /** @deprecated use platforms.telegram.allowedChatIds */
  allowedChatIds?: number[];
  platforms?: PlatformsConfig;
  sessionId?: string;
  sessionMode?: string;
  sessionConfigPath?: string;
  showThoughts?: boolean;
  showTools?: boolean;
  showPlan?: boolean;
  streaming?: boolean;
  echoInjectedPrompts?: boolean;
  logLevel?: LogLevel;
  cron?: CronJob[];
  routines?: Routine[];
  http?: HttpConfig;
  media?: MediaConfig;
  a2a?: A2aConfig;
}

export const defaultConfigPath = resolve(process.cwd(), 'acp-connector.jsonc');

const REQUIRED_FIELDS: Record<string, string> = {
  agentCmd: 'string',
};

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function validateConfig(config: unknown): asserts config is BridgeConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }
  const obj = config as Record<string, unknown>;
  for (const [field, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`config is missing required field: ${field}`);
    }
    if (typeof obj[field] !== expectedType) {
      throw new Error(`config field "${field}" must be of type ${expectedType}`);
    }
  }

  // Must have either a messaging platform or a headless channel
  // (HTTP API or A2A network) — otherwise the bridge has no inputs.
  const hasPlatforms = obj.platforms && typeof obj.platforms === 'object';
  const hasLegacy = typeof obj.telegramToken === 'string';
  const hasHeadless =
    (obj.http as Record<string, unknown> | undefined)?.enabled === true ||
    (obj.a2a as Record<string, unknown> | undefined)?.enabled === true;
  if (!hasPlatforms && !hasLegacy && !hasHeadless) {
    throw new Error(
      'config must have either platforms.telegram.token, telegramToken, http.enabled, or a2a.enabled'
    );
  }
}

function migrateLegacyConfig(config: BridgeConfig): BridgeConfig {
  if (config.telegramToken && !config.platforms?.telegram) {
    log.warn('⚠️ telegramToken at root is deprecated. Move to platforms.telegram.token.');
    config.platforms = config.platforms || {};
    config.platforms.telegram = {
      token: config.telegramToken,
      allowedChatIds: config.allowedChatIds || [],
    };
  }
  // Ensure allowedChatIds exists in platforms.telegram
  if (config.platforms?.telegram && !config.platforms.telegram.allowedChatIds) {
    config.platforms.telegram.allowedChatIds = [];
  }
  return config;
}

export function loadConfig(path: string = defaultConfigPath): BridgeConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const stripped = stripJsonc(raw);
  if (stripped.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Invalid config JSON in ${path}: ${(err as Error).message}`);
  }
  validateConfig(parsed);
  return migrateLegacyConfig(parsed);
}

export function saveConfig(config: BridgeConfig, path: string = defaultConfigPath): void {
  if (config === null || config === undefined) {
    throw new Error('saveConfig: config cannot be null or undefined');
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('saveConfig: config must be an object');
  }
  const json = JSON.stringify(config, null, 2);
  writeFileSync(path, `${json}\n`, 'utf8');
}
