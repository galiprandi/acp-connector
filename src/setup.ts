import { createInterface, type Interface } from 'node:readline';
import { type BridgeConfig, type PlatformsConfig, saveConfig } from './config';

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

export async function setup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('acp-connector setup');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('This creates a acp-connector.jsonc here so you can talk to your');
  console.log("coding agent from Telegram and/or Discord. You'll need:");
  console.log('  • A Telegram bot (create one with @BotFather) — optional');
  console.log('  • A Discord bot (create one at discord.com/developers) — optional');
  console.log('  • An ACP-compatible agent installed on this machine');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 1: Agent
  console.log('Step 1: Your coding agent\n');
  console.log('Which agent do you want to control? Any ACP-compatible agent works.');
  console.log('Common options:');
  console.log('  • Devin:        devin acp');
  console.log('  • Claude Code:  claude acp');
  console.log('  • Codex:        codex acp');
  console.log('  • Gemini CLI:   gemini acp');
  console.log('  • OpenCode:     opencode acp\n');
  console.log('You can add flags (e.g. "devin --model glm-5.2 acp")\n');
  const agentCmd = await ask(rl, 'Enter the command to launch your agent: ');
  if (!agentCmd) {
    console.error('\n❌ Agent command is required.');
    rl.close();
    process.exit(1);
  }

  // Step 2: Telegram (optional)
  console.log('\nStep 2: Telegram bot (optional — press Enter to skip)\n');
  console.log('Create a bot by messaging @BotFather on Telegram:');
  console.log('  1. Send /newbot to @BotFather');
  console.log('  2. Pick a name and username');
  console.log('  3. Copy the token it gives you (looks like 123456:ABC-DEF...)\n');
  const telegramToken = await ask(rl, 'Paste your Telegram bot token (or Enter to skip): ');

  let telegramChatId: number | null = null;
  if (telegramToken) {
    console.log('\nTo find your chat ID:');
    console.log('  1. Send any message to your new bot on Telegram');
    console.log('  2. Open https://t.me/userinfobot and forward/start it');
    console.log('  3. It replies with your chat ID (a number like 123456789)\n');
    const chatIdStr = await ask(rl, 'Enter your Telegram chat ID: ');
    const chatId = Number(chatIdStr);
    if (!chatIdStr || Number.isNaN(chatId)) {
      console.error('\n❌ A valid numeric chat ID is required for Telegram.');
      rl.close();
      process.exit(1);
    }
    telegramChatId = chatId;
  }

  // Step 3: Discord (optional)
  console.log('\nStep 3: Discord bot (optional — press Enter to skip)\n');
  console.log('Create a bot at https://discord.com/developers/applications:');
  console.log('  1. Create a New Application');
  console.log('  2. Go to Bot > Reset Token to get your bot token');
  console.log('  3. Enable Message Content Intent under Bot > Privileged Gateway Intents');
  console.log('  4. Invite the bot to your server with the OAuth2 URL Generator\n');
  const discordToken = await ask(rl, 'Paste your Discord bot token (or Enter to skip): ');

  let discordChannelId: string | null = null;
  if (discordToken) {
    console.log('\nTo find a channel ID:');
    console.log('  1. Enable Developer Mode in Discord (Settings > Advanced)');
    console.log('  2. Right-click the channel you want the bot to use');
    console.log('  3. Click "Copy Channel ID"\n');
    const channelIdStr = await ask(rl, 'Enter your Discord channel ID: ');
    if (!channelIdStr) {
      console.error('\n❌ A channel ID is required for Discord.');
      rl.close();
      process.exit(1);
    }
    discordChannelId = channelIdStr;
  }

  if (!telegramToken && !discordToken) {
    console.error('\n❌ At least one platform (Telegram or Discord) is required.');
    rl.close();
    process.exit(1);
  }

  // Step 4: MCP servers (optional)
  console.log('\nStep 4: MCP servers (optional)\n');
  console.log('If your agent needs MCP servers (filesystem, GitHub, etc.),');
  console.log('point to a JSONC file with the server config.');
  console.log("Press Enter to skip if you don't need this.\n");
  const sessionConfigPath = await ask(rl, 'Path to MCP config file (or Enter to skip): ');

  // Step 5: Agent thoughts (optional)
  console.log('\nStep 5: Agent thoughts (optional)\n');
  console.log('Some agents share their reasoning ("thoughts") before responding.');
  console.log('Do you want to see those in chat, or just the final response?\n');
  const showThoughtsStr = await ask(rl, 'Show agent thoughts? (y/N): ');
  const showThoughts =
    showThoughtsStr.toLowerCase() === 'y' || showThoughtsStr.toLowerCase() === 'yes';

  rl.close();

  const platforms: PlatformsConfig = {};
  if (telegramToken && telegramChatId !== null) {
    platforms.telegram = {
      token: telegramToken,
      allowedChatIds: [telegramChatId],
    };
  }
  if (discordToken && discordChannelId !== null) {
    platforms.discord = {
      token: discordToken,
      allowedChannelIds: [discordChannelId],
    };
  }

  const config: BridgeConfig = {
    agentCmd,
    agentCwd: process.cwd(),
    platforms,
    sessionConfigPath: sessionConfigPath || undefined,
    showThoughts,
    streaming: true,
    logLevel: 'info',
    cron: [],
    routines: [],
  };

  saveConfig(config);

  console.log('\n✅ Done! Saved acp-connector.jsonc in this directory.');
  console.log('\nNow start the bridge:');
  console.log('  npx acp-connector');
  console.log('\nThen send a message to your bot.');
  console.log('\nTips:');
  console.log('  • /cron add 0 9 * * * do the daily briefing');
  console.log('  • /routine add briefing summarize my day');
  console.log('  • /run briefing');
  console.log('\nFull docs: https://github.com/galiprandi/acp-connector#readme');
}
