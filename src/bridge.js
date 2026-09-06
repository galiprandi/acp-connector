import { AcpClient } from './acp-client.js';
import { BridgeBot } from './bot.js';
import { loadConfig } from './config.js';
import { CronManager } from './cron.js';
import { HttpServer } from './http.js';
import { RoutineManager } from './routines.js';

/**
 * Print an ASCII box banner with the "acp-connector" title.
 */
function printBanner() {
  const title = 'acp-connector';
  const inner = `  ${title}  `;
  const top = `┌${'─'.repeat(inner.length)}┐`;
  const mid = `│${inner}│`;
  const bot = `└${'─'.repeat(inner.length)}┘`;
  console.log(top);
  console.log(mid);
  console.log(bot);
}

/**
 * Main bridge entrypoint. Loads config, starts ACP, Telegram, cron, HTTP.
 */
export async function run() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Invalid config: ${err.message}`);
    process.exit(1);
  }
  if (!config) {
    console.error('No .config.jsonc found. Run: npx acp-connector setup');
    process.exit(1);
  }

  printBanner();

  // Create ACP client
  const acp = new AcpClient({
    agentCmd: config.agentCmd,
    agentCwd: config.agentCwd,
    sessionConfigPath: config.sessionConfigPath,
    sessionId: config.sessionId,
  });

  // Create bot (needs ACP for permission handling)
  const bot = new BridgeBot({
    acp,
    telegramToken: config.telegramToken,
    allowedChatIds: config.allowedChatIds,
    agentCmd: config.agentCmd,
    showThoughts: config.showThoughts,
    streaming: config.streaming,
  });

  // Create cron manager
  const cronManager = new CronManager({
    jobs: config.cron || [],
    allowedChatIds: config.allowedChatIds,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
  });

  // Create routine manager
  const routineManager = new RoutineManager({
    routines: config.routines || [],
    cronManager,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
    sendMessage: (chatId, text) => bot.sendMessage(chatId, text),
    allowedChatIds: config.allowedChatIds,
  });

  // Wire bridge commands
  bot.onCommand = (text, chatId) => routineManager.handleCommand(text, chatId);

  // Create HTTP server
  const httpServer = new HttpServer({
    enabled: config.http?.enabled || false,
    port: config.http?.port || 7780,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
    getHealth: () => ({
      status: 'ok',
      agent: !!acp.session,
      session: acp.sessionId,
    }),
  });

  // Wire permission handler
  acp.onPermission = (params) => bot._handlePermission(params);

  // Start ACP
  try {
    await acp.start();
  } catch (err) {
    console.error('Failed to start ACP:', err.message);
    process.exit(1);
  }

  // Start bot
  await bot.start();

  // Start cron
  cronManager.start();

  // Start HTTP
  httpServer.start();

  // Print status
  const mode = acp.modes?.currentModeId || 'default';
  console.log('');
  console.log(`  🆔  Session:  ${acp.sessionId}${config.sessionId ? ' (restored)' : ''}`);
  console.log(`  ⚙️  Mode:     ${mode}`);
  console.log(`  💬  Chats:    ${config.allowedChatIds.join(', ') || 'none (setup mode)'}`);
  console.log(`  🖥️  Command:  ${config.agentCmd}`);
  if (config.sessionConfigPath) {
    console.log(`  📋  Config:   ${config.sessionConfigPath}`);
  }
  if (config.cron?.length > 0) {
    console.log(`  ⏰  Cron:     ${config.cron.length} job(s)`);
  }
  if (config.http?.enabled) {
    console.log(`  🌐  HTTP:     port ${config.http.port || 7780}`);
  }
  console.log('');
  console.log('  ─────────────────────────────────');
  console.log('');

  // Graceful shutdown
  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down...`);
    httpServer.stop();
    cronManager.stop();
    bot.stop();
    acp.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  setInterval(() => {}, 1 << 30);
}
