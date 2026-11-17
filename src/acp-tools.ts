#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Unified MCP server giving the agent bridge capabilities: file delivery
 * to chats, chat alias discovery, and the job scheduler (one-shot,
 * recurring and manual jobs — the same model the operator sees via
 * /jobs).
 *
 * Injected by the bridge in `session/new` via `mcpServers` (always, not
 * gated on a2a.enabled). Tools are thin HTTP calls to the bridge's
 * loopback API — scheduling, persistence, alias resolution and message
 * delivery all live in the bridge process.
 *
 * Every user prompt arrives prefixed with sender identity, e.g.
 * `[Telegram/Familia] Santi: ...`. The bracketed label is a chat alias —
 * copy it verbatim into `send_file`'s `to` parameter. Omitting `to`
 * delivers to the chat that sent the current prompt.
 */

const baseUrl = process.env.BRIDGE_API_URL ?? process.env.REMINDERS_API_URL;
if (!baseUrl) {
  console.error('acp-tools: BRIDGE_API_URL is required');
  process.exit(1);
}

const server = new McpServer({ name: 'acp-tools', version: '1.0.0' });

async function call(
  path: string,
  body?: Record<string, unknown>,
  method?: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (!res.ok || json.ok === false) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${json.error ?? `HTTP ${res.status}`}` }],
        isError: true,
      };
    }
    const { ok: _ok, ...rest } = json;
    return { content: [{ type: 'text' as const, text: JSON.stringify(rest) }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

// Forwards only defined params — the loopback API validates per action.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const TIME_HINT =
  'Human relative strings ("30m", "2 hours", "tomorrow 10am", "mañana 10:00") or ISO datetimes are accepted for "in"/"at". `in` = delay from now; `at` = absolute local time in the operator timezone. Naive absolute times require the configured `timezone` — if the tool errors about a missing zone, ask the operator or include an explicit offset (e.g. -03:00). The response includes firesAtLocal and now — relay the confirmed time AND its GMT offset to the user so they can spot a wrong timezone.';

// ---------------------------------------------------------------- messaging

server.registerTool(
  'send_file',
  {
    description:
      'Send a local file to a chat. Path must be inside the agent workspace or configured upload/tmp dirs — arbitrary paths are rejected. Images are sent with preview. `to` accepts a chat alias exactly as it appears in prompt prefixes (e.g. "Telegram/Familia", "Discord/General") or from list_aliases; omit it to reply to the chat that sent the current prompt.',
    inputSchema: {
      path: z.string().describe('Absolute or ~ path of the file to send'),
      caption: z.string().optional().describe('Optional caption shown with the file'),
      to: z
        .string()
        .optional()
        .describe('Chat alias (e.g. "Telegram/Familia") — default: current chat'),
    },
  },
  async ({ path, caption, to }) => call('/file/send', compact({ path, caption, to }))
);

server.registerTool(
  'list_aliases',
  {
    description:
      'List known chat aliases the agent can target with send_file `to`. Each entry has alias, platform, kind (dm|group) and name — raw platform ids are never exposed. Aliases appear automatically in prompt prefixes like [Telegram/Familia].',
    inputSchema: {},
  },
  async () => call('/aliases')
);

// -------------------------------------------------------------------- jobs

server.registerTool(
  'jobs',
  {
    description: `Manage scheduled prompts — the same jobs the operator sees via /jobs. One tool covers one-shot reminders, recurring schedules and manual jobs the operator triggers by name. Write prompts fully self-contained — when a job fires you will not see this conversation. Jobs you create are yours (managed "agent"): only you can update, toggle, run or delete them; operator jobs are read-only. ${TIME_HINT} Use manual:true + name to create a named job the operator can fire on demand (like a saved routine/skill).`,
    inputSchema: {
      action: z
        .enum(['create', 'list', 'update', 'delete', 'run', 'toggle'])
        .describe('create: schedule a job | list: all jobs | update/delete/run/toggle: by id'),
      id: z.string().optional().describe('Job id (required for update/delete/run/toggle)'),
      name: z.string().optional().describe('Human name — required for manual jobs, useful for all'),
      prompt: z
        .string()
        .optional()
        .describe('Self-contained instruction injected when the job fires'),
      in: z.string().optional().describe('Delay until firing, e.g. "15m", "2 hours"'),
      at: z
        .string()
        .optional()
        .describe('Absolute fire time, e.g. "tomorrow 10am" or ISO datetime'),
      every: z
        .string()
        .optional()
        .describe('Human interval: "30m", "1h", "6h", "1d", "1w" (even divisors only)'),
      expr: z
        .string()
        .optional()
        .describe('Raw 5-field cron expression, e.g. "0 9 * * *" (minute hour day month weekday)'),
      manual: z
        .boolean()
        .optional()
        .describe('true = manual job: never fires on its own, operator triggers it by name'),
      enabled: z.boolean().optional().describe('Pause (false) or resume (true) the job'),
    },
  },
  async ({ action, id, name, prompt, in: inStr, at, every, expr, manual, enabled }) => {
    const schedule = compact({ in: inStr, at, every, expr, manual });
    switch (action) {
      case 'list':
        return call('/jobs/list');
      case 'create':
        return call('/jobs/create', compact({ prompt, name, ...schedule }));
      case 'update':
        return call('/jobs/update', compact({ id, prompt, name, enabled, ...schedule }));
      case 'delete':
        return call('/jobs/delete', compact({ id }));
      case 'run':
        return call('/jobs/run', compact({ id }));
      case 'toggle':
        return call('/jobs/toggle', compact({ id }));
    }
  }
);

await server.connect(new StdioServerTransport());
