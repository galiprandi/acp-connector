#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Unified MCP server giving the agent bridge capabilities: file delivery
 * to chats, chat alias discovery, self-reminders and self-managed cron.
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
  'Human relative strings ("30m", "2 hours", "tomorrow 10am", "mañana 10:00") or ISO datetimes are accepted. `in` = delay from now; `at` = absolute local time in the operator timezone. Naive absolute times require the configured `timezone` — if the tool errors about a missing zone, ask the operator or include an explicit offset (e.g. -03:00).';

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

// --------------------------------------------------------------- reminders

server.registerTool(
  'reminder',
  {
    description: `Manage one-shot self-reminders. Reminders are one-shot: they fire once and are deleted on delivery. For recurring work use cron instead. Write prompts fully self-contained — when one fires you will not see this conversation. The response includes firesAtLocal — relay the confirmed time AND its GMT offset to the user so they can spot a wrong timezone. Only reminders you created (managed "agent") can be cancelled or updated — operator reminders are read-only. ${TIME_HINT}`,
    inputSchema: {
      action: z
        .enum(['create', 'list', 'cancel', 'update'])
        .describe('create: schedule | list: pending reminders | cancel/update: by id'),
      id: z.string().optional().describe('Reminder id (required for cancel/update)'),
      prompt: z
        .string()
        .optional()
        .describe('Self-contained instruction (required for create; new text for update)'),
      in: z.string().optional().describe('Delay until firing, e.g. "15m", "2 hours"'),
      at: z
        .string()
        .optional()
        .describe('Absolute fire time, e.g. "tomorrow 10am" or ISO datetime'),
    },
  },
  async ({ action, id, prompt, in: inStr, at }) => {
    switch (action) {
      case 'list':
        return call('/reminder/list');
      case 'create':
        return call('/reminder/create', compact({ prompt, in: inStr, at }));
      case 'cancel':
        return call('/reminder/cancel', compact({ id }));
      case 'update':
        return call('/reminder/update', compact({ id, in: inStr, at, prompt }));
    }
  }
);

// -------------------------------------------------------------------- cron

server.registerTool(
  'cron',
  {
    description:
      'Manage recurring scheduled prompts owned by you (the agent). Use for routines: daily checks, periodic cleanups, follow-up loops that repeat. The prompt is injected into the bridge queue on every fire — write it self-contained. For one-shot follow-ups use reminder instead. Only jobs you created (managed "agent") can be updated or deleted — operator jobs are read-only.',
    inputSchema: {
      action: z
        .enum(['create', 'list', 'update', 'delete'])
        .describe('create: schedule recurring | list: all jobs | update/delete: by id'),
      id: z.string().optional().describe('Cron job id (required for update/delete)'),
      every: z
        .string()
        .optional()
        .describe('Human interval: "30m", "1h", "6h", "1d", "1w" (even divisors only)'),
      expr: z
        .string()
        .optional()
        .describe('Raw 5-field cron expression, e.g. "0 9 * * *" (minute hour day month weekday)'),
      prompt: z.string().optional().describe('Self-contained instruction injected on every fire'),
      enabled: z.boolean().optional().describe('Pause (false) or resume (true) the job'),
    },
  },
  async ({ action, id, every, expr, prompt, enabled }) => {
    switch (action) {
      case 'list':
        return call('/cron/list');
      case 'create':
        return call('/cron/create', compact({ every, expr, prompt }));
      case 'update':
        return call('/cron/update', compact({ id, every, expr, prompt, enabled }));
      case 'delete':
        return call('/cron/delete', compact({ id }));
    }
  }
);

await server.connect(new StdioServerTransport());
