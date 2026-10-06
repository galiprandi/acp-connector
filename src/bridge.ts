import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A2aServer } from './a2a.js';
import { A2aManager } from './a2a-manager.js';
import { AcpClient } from './acp-client.js';
import { buildAgentCard } from './agent-card.js';
import type { PlatformBot } from './bot.js';
import { BridgeBot } from './bot.js';
import { type BridgeConfig, loadConfig } from './config.js';
import { CronManager } from './cron.js';
import { DiscordBot } from './discord.js';
import { DiscoveryService } from './discovery.js';
import { HttpServer } from './http.js';
import { log, setLogLevel } from './logger.js';
import { LoopbackBot } from './loopback.js';
import { MediaHandler } from './media.js';
import { AuditLog, NetworkStore } from './network.js';
import { RoutineManager } from './routines.js';

function printBanner(): void {
  const title = 'acp-connector';
  const inner = `  ${title}  `;
  const top = `┌${'─'.repeat(inner.length)}┐`;
  const mid = `│${inner}│`;
  const bot = `└${'─'.repeat(inner.length)}┘`;
  log.info(top);
  log.info(mid);
  log.info(bot);
}

export async function run(): Promise<void> {
  let config: BridgeConfig | null;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(`Invalid config: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!config) {
    log.error('No acp-connector.jsonc found. Run: npx acp-connector setup');
    process.exit(1);
  }

  setLogLevel(config.logLevel);

  printBanner();

  // A2A network MCP server: gives the agent list_remote_agents /
  // send_message tools (the reference A2A host-agent pattern). Agents
  // without MCP support simply never see these tools.
  const a2aMcpServers: unknown[] = [];
  if (config.a2a?.enabled) {
    const isTs = import.meta.url.endsWith('.ts');
    const mcpScript = fileURLToPath(new URL(`./a2a-mcp.${isTs ? 'ts' : 'js'}`, import.meta.url));
    a2aMcpServers.push({
      name: 'a2a-network',
      command: isTs ? 'npx' : process.execPath,
      args: isTs ? ['tsx', mcpScript] : [mcpScript],
      env: [
        {
          name: 'A2A_BASE_URL',
          value: `http://127.0.0.1:${config.a2a.port ?? 7741}`,
        },
      ],
    });
  }

  const acp = new AcpClient({
    agentCmd: config.agentCmd,
    agentCwd: config.agentCwd,
    sessionConfigPath: config.sessionConfigPath,
    sessionId: config.sessionId,
    sessionMode: config.sessionMode,
    mcpServers: a2aMcpServers,
  });

  const tg = config.platforms?.telegram;
  const dc = config.platforms?.discord;

  const headless = !tg && !dc;
  if (headless && !config.http?.enabled && !config.a2a?.enabled) {
    log.error('No platform configured. Run: npx acp-connector setup');
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
      showTools: config.showTools,
      showPlan: config.showPlan,
      streaming: config.streaming,
      echoInjectedPrompts: config.echoInjectedPrompts,
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
      showTools: config.showTools,
      showPlan: config.showPlan,
      streaming: config.streaming,
      echoInjectedPrompts: config.echoInjectedPrompts,
    });
    bots.push(bot);
    if (!primaryBot) primaryBot = bot;
  }

  // Headless mode: HTTP /prompt and A2A still need a queue processor.
  if (bots.length === 0) {
    const loopback = new LoopbackBot(acp);
    bots.push(loopback);
    primaryBot = loopback;
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
        bot.enqueuePrompt(text, chatId, undefined, undefined, 'cron');
      }
    },
  });

  const routineManager = new RoutineManager({
    routines: config.routines || [],
    cronManager,
    enqueue: (text, chatId) => {
      for (const bot of bots) {
        bot.enqueuePrompt(text, chatId, undefined, undefined, 'routine');
      }
    },
    sendMessage: async (chatId, text) => {
      // Send to all bots — each will deliver if it can
      for (const bot of bots) {
        await bot.sendMessage(chatId, text);
      }
    },
  });

  // A2A manager: pairing + /a2a commands (created early for command wiring)
  let a2aManager: A2aManager | null = null;
  let a2aNetwork: NetworkStore | null = null;
  let a2aAudit: AuditLog | null = null;
  let a2aSyncTimer: ReturnType<typeof setInterval> | null = null;
  if (config.a2a?.enabled) {
    const stateDir = resolve(config.agentCwd ?? process.cwd(), '.acp-connector');
    a2aNetwork = new NetworkStore(resolve(stateDir, 'network.json'));
    a2aAudit = new AuditLog(resolve(stateDir, 'audit.log'));
    const ownerChatIds: Array<number | string> = [
      ...(tg?.allowedChatIds ?? []),
      ...(dc?.allowedChannelIds ?? []),
    ];
    const a2aHost = config.a2a.host ?? '127.0.0.1';
    const a2aPort = config.a2a.port ?? 7741;
    const selfCardUrl = `http://${a2aHost}:${a2aPort}/.well-known/agent-card.json`;
    let selfCard: Record<string, unknown> | undefined;
    try {
      selfCard = buildAgentCard(config.a2a, `http://${a2aHost}:${a2aPort}`);
    } catch (err) {
      log.warn(`A2A card not configured: ${(err as Error).message}`);
    }
    a2aManager = new A2aManager({
      network: a2aNetwork,
      selfId: config.a2a.id ?? config.a2a.card?.name?.toLowerCase() ?? 'agent',
      selfCardUrl,
      selfCard,
      audit: a2aAudit ?? undefined,
      notify: async (text) => {
        for (const bot of bots) {
          for (const chatId of ownerChatIds) {
            await bot.sendMessage(chatId, text);
          }
        }
      },
    });
    a2aManager.reply = async (chatId, text) => {
      for (const bot of bots) {
        await bot.sendMessage(chatId, text).catch(() => {});
      }
    };
  }

  // Wire bridge commands to all bots (routines first, then /a2a)
  for (const bot of bots) {
    bot.setCommandHandler((text, chatId) =>
      routineManager.handleCommand(text, chatId as number).then(async (handled) => {
        if (handled) return true;
        return a2aManager ? a2aManager.handleCommand(text, chatId) : false;
      })
    );
  }

  const httpServer = new HttpServer({
    enabled: config.http?.enabled || false,
    host: config.http?.host || '127.0.0.1',
    port: config.http?.port || 7780,
    authToken: config.http?.auth?.token || null,
    forwardHeaders: config.http?.forwardHeaders || false,
    maxBodySize: config.http?.maxBodySize || 1024 * 1024,
    rateLimit: config.http?.rateLimit || 60,
    enqueue: (text, chatId, blocks, onComplete) => {
      for (const bot of bots) {
        bot.enqueuePrompt(text, chatId, blocks, onComplete, 'http');
      }
    },
    getHealth: () => ({
      status: 'ok',
      agent: !!acp.session,
      session: acp.sessionId,
    }),
  });

  // Notify all allowed chats when the agent process dies — each platform
  // bot sends a message with a "Reconnect" button that calls acp.restart()
  acp.onExit = (code) => {
    log.error(`⚠️ Agent process exited (code=${code})`);
    for (const bot of bots) {
      bot.notifyAgentExit(code).catch((err) => {
        log.error('Failed to send agent-exit notification:', (err as Error).message);
      });
    }
  };

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
    log.error('Failed to start ACP:', (err as Error).message);
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

  // A2A network layer: agent card + JSON-RPC endpoint for peer agents
  let a2aServer: A2aServer | null = null;
  let a2aDiscovery: DiscoveryService | null = null;
  if (config.a2a?.enabled && a2aNetwork && a2aManager) {
    const selfId = config.a2a.id ?? config.a2a.card?.name?.toLowerCase() ?? 'agent';
    for (const peerId of config.a2a.trustedPeers ?? []) {
      if (!a2aNetwork.getPeer(peerId)) {
        a2aNetwork.upsertPeer({ id: peerId, cardUrl: '', status: 'approved', source: 'declared' });
      }
    }
    if (config.a2a.registryMode) a2aNetwork.role = 'registry';
    a2aNetwork.save();

    a2aServer = new A2aServer({
      config: config.a2a,
      network: a2aNetwork,
      selfId,
      enqueue: (text, chatId, blocks, onComplete) => {
        const target = primaryBot ?? bots[0];
        target?.enqueuePrompt(text, chatId, blocks, onComplete, 'a2a');
      },
      onJoin: (req) => a2aManager.handleJoinRequest(req),
      onConfirm: (peerId) => a2aManager.handleConfirm(peerId),
      audit: a2aAudit ?? undefined,
    });
    await a2aServer.start();

    // Peer discovery: shared-file + mDNS + static. New peers are
    // announced to the owner; membership still requires /a2a join.
    a2aDiscovery = new DiscoveryService({
      config: config.a2a,
      network: a2aNetwork,
      selfId,
      selfCardUrl: a2aServer.cardUrl(),
    });
    await a2aDiscovery.start();
    const discovery = a2aDiscovery;
    const syncNetwork = async () => {
      const found = await discovery.discover();
      await a2aManager.notifyDiscovered(found.map((p) => ({ id: p.id, cardUrl: p.cardUrl })));
      // Refresh real cards (well-known URI) for approved peers and announce
      // ourselves to the registry if one is configured.
      for (const p of a2aNetwork.listPeers('approved')) {
        await a2aManager.refreshPeerCard(p.id).catch(() => {});
      }
      if (config.a2a?.registry) {
        await a2aManager.announceToRegistry(config.a2a.registry).catch(() => {});
      }
      a2aNetwork.save();
    };
    await syncNetwork();
    await a2aManager.remindPending();
    a2aSyncTimer = setInterval(() => syncNetwork().catch(() => {}), 5 * 60 * 1000);
    a2aSyncTimer.unref?.();
  }

  const mode = acp.modes?.currentModeId || 'default';
  log.info('');
  log.info(`  🆔  Session:  ${acp.sessionId}${config.sessionId ? ' (restored)' : ''}`);
  log.info(`  ⚙️  Mode:     ${mode}`);
  if (tg) {
    log.info(`  💬  TG Chats:    ${tg.allowedChatIds.join(', ') || 'none (setup mode)'}`);
  }
  if (dc) {
    log.info(`  💬  DC Channels: ${dc.allowedChannelIds.join(', ') || 'none (setup mode)'}`);
  }
  log.info(`  🖥️  Command:  ${config.agentCmd}`);
  if (config.sessionConfigPath) {
    log.info(`  📋  Config:   ${config.sessionConfigPath}`);
  }
  if (config.cron && config.cron.length > 0) {
    log.info(`  ⏰  Cron:     ${config.cron.length} job(s)`);
  }
  if (config.http?.enabled) {
    log.info(`  🌐  HTTP:     port ${config.http.port || 7780}`);
  }
  log.info('');
  log.info('  ─────────────────────────────────');
  log.info('');

  const shutdown = (sig: string) => {
    log.info(`\n${sig} received, shutting down...`);
    if (a2aSyncTimer) clearInterval(a2aSyncTimer);
    a2aDiscovery?.stop();
    a2aServer?.stop();
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
