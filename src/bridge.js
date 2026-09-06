import { loadConfig } from './config.js';

/**
 * Print an ASCII box banner with the "acpbridge" title.
 */
function printBanner() {
  const title = 'acpbridge';
  const inner = `  ${title}  `;
  const top = '┌' + '─'.repeat(inner.length) + '┐';
  const mid = '│' + inner + '│';
  const bot = '└' + '─'.repeat(inner.length) + '┘';
  console.log(top);
  console.log(mid);
  console.log(bot);
}

/**
 * Main bridge entrypoint. Loads config, prints banner, and keeps alive.
 */
export async function run() {
  const config = loadConfig();
  if (!config) {
    console.error('No .config.jsonc found. Run: npx acpbridge setup');
    process.exit(1);
  }

  printBanner();

  // Placeholder: ACP client init
  // Placeholder: Telegram bot init
  // Placeholder: cron init
  // Placeholder: HTTP init

  console.log('Bridge started');

  // Keep process alive
  setInterval(() => {}, 1 << 30);
}
