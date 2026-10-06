#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP server exposing the agent network to the local ACP agent.
 *
 * Mirrors the reference A2A host-agent pattern (a2a-samples HostAgent):
 * the agent gets `list_remote_agents` and `send_message` as real tools.
 * The bridge registers this server in `session/new` via `mcpServers`
 * when `a2a.enabled`. Agents without MCP support simply never see them.
 *
 * Tools hit the bridge's loopback agent-facing endpoints — all trust
 * checks (approved peers, dedup, loop prevention) live there.
 */

const baseUrl = process.env.A2A_BASE_URL;
if (!baseUrl) {
  console.error('a2a-mcp: A2A_BASE_URL is required');
  process.exit(1);
}

const server = new McpServer({ name: 'a2a-network', version: '1.0.0' });

server.registerTool(
  'list_remote_agents',
  {
    description:
      'List the available remote agents you can delegate tasks to. Returns each agent name and description.',
    inputSchema: {},
  },
  async () => {
    const res = await fetch(`${baseUrl}/a2a/peers`);
    const body = (await res.json()) as {
      peers: Array<{ id: string; name: string; skills: string[] }>;
    };
    const agents = body.peers.map((p) => ({
      name: p.id,
      description: `${p.name} — skills: ${p.skills.join(', ') || 'none declared'}`,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(agents) }] };
  }
);

server.registerTool(
  'send_message',
  {
    description:
      'Send a task message to a remote agent and get its response. Use list_remote_agents to find available agent names.',
    inputSchema: {
      agent_name: z.string().describe('The name of the remote agent to send the task to'),
      message: z.string().describe('The task or message to send to the agent'),
    },
  },
  async ({ agent_name, message }) => {
    const res = await fetch(`${baseUrl}/a2a/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: agent_name, text: message }),
    });
    const body = (await res.json()) as { result?: string; error?: string };
    if (!res.ok || body.error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${body.error ?? `HTTP ${res.status}`}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: body.result ?? '' }] };
  }
);

await server.connect(new StdioServerTransport());
