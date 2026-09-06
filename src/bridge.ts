import { AcpClient } from './acp-client';
import { BridgeBot } from './bot';
import { type BridgeConfig, loadConfig } from './config';
import { CronManager } from './cron';
import { HttpServer } from './http';
import { RoutineManager } from './routines';

function printBanner(): void {
  const title = 'acp-connector';
  const inner = `  ${title}  `;
  const top = `┌${'─'.repeat(inner.length)}┐`;
  const mid = `│${inner}│`;
  const bot = `└${'─'.repeat(inner.length)}┘`;
  console.log(top);
  console.log(mid);
  console.log(bot);
}

export async function run(): Promise<void> {
  let config: BridgeConfig | null;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Invalid config: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!config) {
    console.error('No .config.jsonc found. Run: npx acp-connector setup');
    process.exit(1);
  }

  printBanner();

  const acp = new AcpClient({
    agentCmd: config.agentCmd,
    agentCwd: config.agentCwd,
    sessionConfigPath: config.sessionConfigPath,
    sessionId: config.sessionId,
  });

  const bot = new BridgeBot({
    acp,
    telegramToken: config.telegramToken,
    allowedChatIds: config.allowedChatIds,
    agentCmd: config.agentCmd,
    showThoughts: config.showThoughts,
    streaming: config.streaming,
  });

  const cronManager = new CronManager({
    jobs: config.cron || [],
    allowedChatIds: config.allowedChatIds,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
  });

  const routineManager = new RoutineManager({
    routines: config.routines || [],
    cronManager,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
    sendMessage: (chatId, text) => bot.sendMessage(chatId, text),
  });

  bot.onCommand = (text, chatId) => routineManager.handleCommand(text, chatId);

  const httpServer = new HttpServer({
    enabled: config.http?.enabled || false,
    host: config.http?.host || '127.0.0.1',
    port: config.http?.port || 7780,
    authToken: config.http?.auth?.token || null,
    forwardHeaders: config.http?.forwardHeaders || false,
    maxBodySize: config.http?.maxBodySize || 1024 * 1024,
    rateLimit: config.http?.rateLimit || 60,
    enqueue: (text, chatId) => bot.enqueuePrompt(text, chatId),
    getHealth: () => ({
      status: 'ok',
      agent: !!acp.session,
      session: acp.sessionId,
    }),
  });

  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types are complex
  acp.onPermission = (params: any) => bot._handlePermission(params);

  try {
    await acp.start();
  } catch (err) {
    console.error('Failed to start ACP:', (err as Error).message);
    process.exit(1);
  }

  await bot.start();
  cronManager.start();
  await httpServer.start();

  const mode = acp.modes?.currentModeId || 'default';
  console.log('');
  console.log(`  🆔  Session:  ${acp.sessionId}${config.sessionId ? ' (restored)' : ''}`);
  console.log(`  ⚙️  Mode:     ${mode}`);
  console.log(`  💬  Chats:    ${config.allowedChatIds.join(', ') || 'none (setup mode)'}`);
  console.log(`  🖥️  Command:  ${config.agentCmd}`);
  if (config.sessionConfigPath) {
    console.log(`  📋  Config:   ${config.sessionConfigPath}`);
  }
  if (config.cron && config.cron.length > 0) {
    console.log(`  ⏰  Cron:     ${config.cron.length} job(s)`);
  }
  if (config.http?.enabled) {
    console.log(`  🌐  HTTP:     port ${config.http.port || 7780}`);
  }
  console.log('');
  console.log('  ─────────────────────────────────');
  console.log('');

  const shutdown = (sig: string) => {
    console.log(`\n${sig} received, shutting down...`);
    httpServer.stop();
    cronManager.stop();
    bot.stop();
    acp.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  setInterval(() => {}, 1 << 30);
}
