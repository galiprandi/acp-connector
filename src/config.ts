import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  chatId?: number;
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

export interface TelegramPlatformConfig {
  token: string;
  allowedChatIds: number[];
}

export interface DiscordPlatformConfig {
  token: string;
  allowedChannelIds: number[];
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
  sessionConfigPath?: string;
  showThoughts?: boolean;
  streaming?: boolean;
  logLevel?: 'error' | 'info' | 'debug';
  cron?: CronJob[];
  routines?: Routine[];
  http?: HttpConfig;
}

export const defaultConfigPath = resolve(process.cwd(), 'acp-connector.jsonc');

const REQUIRED_FIELDS: Record<string, string> = {
  agentCmd: 'string',
};

function stripJsonc(text: string): string {
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

  // Must have either platforms.telegram or legacy telegramToken
  const hasPlatforms = obj.platforms && typeof obj.platforms === 'object';
  const hasLegacy = typeof obj.telegramToken === 'string';
  if (!hasPlatforms && !hasLegacy) {
    throw new Error('config must have either platforms.telegram.token or telegramToken');
  }
}

function migrateLegacyConfig(config: BridgeConfig): BridgeConfig {
  if (config.telegramToken && !config.platforms?.telegram) {
    console.warn('⚠️ telegramToken at root is deprecated. Move to platforms.telegram.token.');
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
