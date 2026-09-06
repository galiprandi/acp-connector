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
 * Load and parse the .config.jsonc file from cwd.
 * @returns {BridgeConfig | null}
 */
export function loadConfig() {
  if (!existsSync(defaultConfigPath)) return null;
  const raw = readFileSync(defaultConfigPath, 'utf8');
  const stripped = stripJsonc(raw);
  return JSON.parse(stripped);
}

/**
 * Write config back to .config.jsonc (as pretty JSONC, no comments).
 * @param {BridgeConfig} config
 */
export function saveConfig(config) {
  const json = JSON.stringify(config, null, 2);
  writeFileSync(defaultConfigPath, `${json}\n`, 'utf8');
}
