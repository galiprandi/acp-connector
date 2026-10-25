#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP server giving the agent self-reminder and self-managed cron tools.
 *
 * Injected by the bridge in `session/new` via `mcpServers` (always, not
 * gated on a2a.enabled). Tools are thin HTTP calls to the bridge's
 * loopback reminders API — scheduling, persistence and prompt delivery
 * all live in the bridge process.
 *
 * Reminders are one-shot: they fire once and are deleted on delivery.
 * For recurring work the agent uses the cron_* tools instead.
 */

const baseUrl = process.env.REMINDERS_API_URL;
if (!baseUrl) {
  console.error('reminders-mcp: REMINDERS_API_URL is required');
  process.exit(1);
}

const server = new McpServer({ name: 'agent-reminders', version: '1.0.0' });

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

const TIME_HINT =
  'Human relative strings ("30m", "2 hours", "tomorrow 10am", "mañana 10:00") or ISO datetimes are accepted. `in` = delay from now; `at` = absolute local time in the operator timezone.';

server.registerTool(
  'reminder_create',
  {
    description: `Schedule a one-shot self-reminder. Use it after an action that needs follow-up (e.g. "check if X replied", "verify the deploy finished"). Write the prompt fully self-contained — when it fires you will not see this conversation, so include all needed context (names, ids, what to check, what to do). For recurring work use cron_create instead. ${TIME_HINT}`,
    inputSchema: {
      prompt: z.string().describe('Self-contained instruction to receive when the reminder fires'),
      in: z.string().optional().describe('Delay until firing, e.g. "15m", "2 hours", "1 day"'),
      at: z
        .string()
        .optional()
        .describe('Absolute fire time, e.g. "tomorrow 10am" or "2026-03-01T10:00"'),
    },
  },
  async ({ prompt, in: inStr, at }) => call('/reminder/create', { prompt, in: inStr, at })
);

server.registerTool(
  'reminder_list',
  {
    description:
      'List all pending reminders with their id and firesAt (UTC). Use it before creating duplicates or when the operator asks what is scheduled.',
    inputSchema: {},
  },
  async () => call('/reminder/list')
);

server.registerTool(
  'reminder_cancel',
  {
    description: 'Cancel a pending reminder by id (get ids from reminder_list).',
    inputSchema: {
      id: z.string().describe('Reminder id from reminder_list'),
    },
  },
  async ({ id }) => call('/reminder/cancel', { id })
);

server.registerTool(
  'reminder_update',
  {
    description: `Reschedule (snooze) or reword a pending reminder. Pass the id plus a new "in"/"at" and/or a new "prompt". ${TIME_HINT}`,
    inputSchema: {
      id: z.string().describe('Reminder id from reminder_list'),
      in: z.string().optional().describe('New delay until firing, e.g. "30m"'),
      at: z.string().optional().describe('New absolute fire time'),
      prompt: z.string().optional().describe('New self-contained prompt'),
    },
  },
  async ({ id, in: inStr, at, prompt }) => call('/reminder/update', { id, in: inStr, at, prompt })
);

server.registerTool(
  'cron_create',
  {
    description:
      'Create a recurring scheduled prompt owned by you (the agent). Use for routines: daily checks, periodic cleanups, follow-up loops that repeat. The prompt is injected into the bridge queue on every fire — write it self-contained. For one-shot follow-ups use reminder_create instead.',
    inputSchema: {
      every: z
        .string()
        .optional()
        .describe('Human interval: "30m", "1h", "6h", "1d", "1w" (even divisors only)'),
      expr: z
        .string()
        .optional()
        .describe('Raw 5-field cron expression, e.g. "0 9 * * *" (minute hour day month weekday)'),
      prompt: z.string().describe('Self-contained instruction injected on every fire'),
    },
  },
  async ({ every, expr, prompt }) => call('/cron/create', { every, expr, prompt })
);

server.registerTool(
  'cron_list',
  {
    description:
      'List all cron jobs. Jobs you created are flagged managed="agent" and can be updated/deleted; operator jobs are read-only (readOnly=true).',
    inputSchema: {},
  },
  async () => call('/cron/list')
);

server.registerTool(
  'cron_update',
  {
    description:
      'Update one of your own cron jobs (managed="agent" only): change the schedule (every or expr), the prompt, or enabled. Operator jobs cannot be modified.',
    inputSchema: {
      id: z.string().describe('Cron job id from cron_list'),
      every: z.string().optional().describe('New human interval, e.g. "1h"'),
      expr: z.string().optional().describe('New 5-field cron expression'),
      prompt: z.string().optional().describe('New prompt'),
      enabled: z.boolean().optional().describe('Pause (false) or resume (true) the job'),
    },
  },
  async ({ id, every, expr, prompt, enabled }) =>
    call('/cron/update', { id, every, expr, prompt, enabled })
);

server.registerTool(
  'cron_delete',
  {
    description:
      'Delete one of your own cron jobs (managed="agent" only). Operator jobs cannot be deleted — ask the user instead.',
    inputSchema: {
      id: z.string().describe('Cron job id from cron_list'),
    },
  },
  async ({ id }) => call('/cron/delete', { id })
);

await server.connect(new StdioServerTransport());
