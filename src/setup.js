import { createInterface } from 'node:readline';
import { saveConfig } from './config.js';

/**
 * @param {import('node:readline').Interface} rl
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

/**
 * Interactive setup wizard. Prompts for required fields and fills defaults.
 */
export async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('acp-connector setup\n');

  const telegramToken = await ask(rl, 'Telegram bot token (required): ');
  if (!telegramToken) {
    console.error('Telegram bot token is required.');
    rl.close();
    process.exit(1);
  }

  const agentCmd = await ask(rl, 'Agent command (required, e.g. "devin acp"): ');
  if (!agentCmd) {
    console.error('Agent command is required.');
    rl.close();
    process.exit(1);
  }

  console.log('\nYou can get your Telegram chat ID by messaging @userinfobot on Telegram.');
  const chatIdStr = await ask(rl, 'Your Telegram chat ID (required): ');
  const chatId = Number(chatIdStr);
  if (!chatIdStr || Number.isNaN(chatId)) {
    console.error('A valid numeric Telegram chat ID is required.');
    rl.close();
    process.exit(1);
  }

  rl.close();

  saveConfig({
    agentCmd,
    agentCwd: process.cwd(),
    telegramToken,
    allowedChatIds: [chatId],
    showThoughts: false,
    streaming: true,
    logLevel: 'info',
    cron: [],
    routines: [],
  });

  console.log('\nSaved .config.jsonc in the current directory.');
  console.log('Run `npx acp-connector` to start the bridge.');
}
