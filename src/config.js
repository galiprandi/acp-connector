import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {Object} CronJob
 * @property {string} name
 * @property {string} schedule
 * @property {string} prompt
 * @property {number} chatId
 */

/**
 * @typedef {Object} Routine
 * @property {string} name
 * @property {string} prompt
 */

/**
 * @typedef {Object} HttpConfig
 * @property {boolean} enabled
 * @property {number} port
 */

/**
 * @typedef {Object} BridgeConfig
 * @property {string} agentCmd - Command to launch the ACP agent (e.g. "acp-agent serve")
 * @property {string} [agentCwd] - Working directory for the agent (default: cwd)
 * @property {string} telegramToken - Telegram bot token
 * @property {number[]} allowedChatIds - Allowed Telegram chat IDs
 * @property {string} [sessionId] - ACP session ID to load/resume (optional, creates new if absent)
 * @property {string} [sessionConfigPath] - Path to MCP/session config jsonc (optional)
 * @property {boolean} [showThoughts=false] - Forward agent thoughts to Telegram
 * @property {boolean} [streaming=true] - Stream responses with message edits
 * @property {string} [logLevel="info"] - "error" | "info" | "debug"
 * @property {CronJob[]} [cron] - Scheduled jobs
 * @property {Routine[]} [routines] - Named reusable prompts
 * @property {HttpConfig} [http] - HTTP server config (optional, default off)
 */

export const defaultConfigPath = resolve(process.cwd(), '.config.jsonc');

/** Required top-level fields with their expected types. */
const REQUIRED_FIELDS = {
  agentCmd: 'string',
  telegramToken: 'string',
  allowedChatIds: 'object', // Array.isArray checked separately
};

/**
 * Strip JSONC comments (// and /* *​/) outside of string literals.
 * @param {string} text
 * @returns {string}
 */
function stripJsonc(text) {
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
      // line comment
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
  // Remove trailing commas (comma before closing ] or }, ignoring whitespace)
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Validate that a parsed config object has all required fields with correct types.
 * @param {any} config
 * @throws {Error} when a required field is missing or has the wrong type
 */
function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }
  for (const [field, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`config is missing required field: ${field}`);
    }
    if (typeof config[field] !== expectedType) {
      throw new Error(`config field "${field}" must be of type ${expectedType}`);
    }
  }
  if (!Array.isArray(config.allowedChatIds)) {
    throw new Error('config field "allowedChatIds" must be an array');
  }
}

/**
 * Load and parse a JSONC config file.
 * @param {string} [path] - path to config file (defaults to .config.jsonc in cwd)
 * @returns {BridgeConfig | null} null when the file does not exist or is empty
 * @throws {Error} when the file exists but is invalid JSON or fails validation
 */
export function loadConfig(path = defaultConfigPath) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const stripped = stripJsonc(raw);
  if (stripped.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Invalid config JSON in ${path}: ${err.message}`);
  }
  validateConfig(parsed);
  return parsed;
}

/**
 * Write config back to a JSONC file (as pretty JSON, no comments).
 * @param {BridgeConfig} config
 * @param {string} [path] - path to config file (defaults to .config.jsonc in cwd)
 */
export function saveConfig(config, path = defaultConfigPath) {
  if (config === null || config === undefined) {
    throw new Error('saveConfig: config cannot be null or undefined');
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('saveConfig: config must be an object');
  }
  const json = JSON.stringify(config, null, 2);
  writeFileSync(path, `${json}\n`, 'utf8');
}
