import { AcpClient } from './acp-client';
import type { PlatformBot } from './bot';
import { BridgeBot } from './bot';
import { type BridgeConfig, loadConfig } from './config';
import { CronManager } from './cron';
import { DiscordBot } from './discord';
import { HttpServer } from './http';
import { MediaHandler } from './media';
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
    console.error('No acp-connector.jsonc found. Run: npx acp-connector setup');
    process.exit(1);
  }

  printBanner();

  const acp = new AcpClient({
    agentCmd: config.agentCmd,
    agentCwd: config.agentCwd,
    sessionConfigPath: config.sessionConfigPath,
    sessionId: config.sessionId,
  });

  const tg = config.platforms?.telegram;
  const dc = config.platforms?.discord;

  if (!tg && !dc) {
    console.error('No platform configured. Run: npx acp-connector setup');
    process.exit(1);
  }

  // Collect active bots
  const bots: PlatformBot[] = [];
  let primaryBot: PlatformBot | null = null;

  if (tg) {
    const bot = new BridgeBot({
      acp,
      telegramToken: tg.token,
      allowedChatIds: tg.allowedChatIds,
      agentCmd: config.agentCmd,
      showThoughts: config.showThoughts,
      streaming: config.streaming,
    });
    bots.push(bot);
    primaryBot = bot;
  }

  if (dc) {
    const bot = new DiscordBot({
      acp,
      token: dc.token,
      allowedChannelIds: dc.allowedChannelIds.map(String),
      agentCmd: config.agentCmd,
      showThoughts: config.showThoughts,
      streaming: config.streaming,
    });
    bots.push(bot);
    if (!primaryBot) primaryBot = bot;
  }

  // Use first bot's allowed IDs for cron (legacy: assumes single platform)
  // Discord channel IDs are strings (Snowflakes exceed JS safe integer range)
  const cronAllowedIds: Array<number | string> = tg?.allowedChatIds || dc?.allowedChannelIds || [];

  const cronManager = new CronManager({
    jobs: config.cron || [],
    allowedChatIds: cronAllowedIds,
    enqueue: (text, chatId) => {
      // Enqueue to all bots — each will process if chatId matches
      for (const bot of bots) {
        bot.enqueuePrompt(text, chatId);
      }
    },
  });

  const routineManager = new RoutineManager({
    routines: config.routines || [],
    cronManager,
    enqueue: (text, chatId) => {
      for (const bot of bots) {
        bot.enqueuePrompt(text, chatId);
      }
    },
    sendMessage: async (chatId, text) => {
      // Send to all bots — each will deliver if it can
      for (const bot of bots) {
        await bot.sendMessage(chatId, text);
      }
    },
  });

  // Wire bridge commands to all bots
  for (const bot of bots) {
    bot.setCommandHandler((text, chatId) => routineManager.handleCommand(text, chatId as number));
  }

  const httpServer = new HttpServer({
    enabled: config.http?.enabled || false,
    host: config.http?.host || '127.0.0.1',
    port: config.http?.port || 7780,
    authToken: config.http?.auth?.token || null,
    forwardHeaders: config.http?.forwardHeaders || false,
    maxBodySize: config.http?.maxBodySize || 1024 * 1024,
    rateLimit: config.http?.rateLimit || 60,
    enqueue: (text, chatId, blocks) => {
      for (const bot of bots) {
        bot.enqueuePrompt(text, chatId, blocks);
      }
    },
    getHealth: () => ({
      status: 'ok',
      agent: !!acp.session,
      session: acp.sessionId,
    }),
  });

  // Wire permission handler — route to the bot that has an active prompt
  // biome-ignore lint/suspicious/noExplicitAny: SDK permission types are complex
  acp.onPermission = (params: any) => {
    // Route to the bot with an active prompt (currentChatId/currentChannelId set)
    for (const bot of bots) {
      if (bot.hasActivePrompt()) {
        // biome-ignore lint/suspicious/noExplicitAny: PlatformBot doesn't expose _handlePermission
        return (bot as any)._handlePermission(params);
      }
    }
    // No active prompt — auto-approve or cancel as fallback
    return { outcome: { outcome: 'cancelled' } };
  };

  try {
    await acp.start();
  } catch (err) {
    console.error('Failed to start ACP:', (err as Error).message);
    process.exit(1);
  }

  // Create media handler now that we know agent capabilities
  const supportsImage = acp.promptCapabilities?.image === true;
  const mediaHandler = new MediaHandler({
    uploadsDir: config.media?.uploadsDir || '/tmp/acp-connector-uploads',
    supportsImage,
  });
  // Inject media handler into bots
  for (const bot of bots) {
    bot.setMediaHandler(mediaHandler);
  }

  // Start all bots
  for (const bot of bots) {
    await bot.start();
  }

  cronManager.start();
  await httpServer.start();

  const mode = acp.modes?.currentModeId || 'default';
  console.log('');
  console.log(`  🆔  Session:  ${acp.sessionId}${config.sessionId ? ' (restored)' : ''}`);
  console.log(`  ⚙️  Mode:     ${mode}`);
  if (tg) {
    console.log(`  💬  TG Chats:    ${tg.allowedChatIds.join(', ') || 'none (setup mode)'}`);
  }
  if (dc) {
    console.log(`  💬  DC Channels: ${dc.allowedChannelIds.join(', ') || 'none (setup mode)'}`);
  }
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
    for (const bot of bots) {
      bot.stop();
    }
    acp.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.stdin.resume();
}
