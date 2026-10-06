import type { A2aConfig } from './config.js';

export const A2A_PROTOCOL_VERSION = '0.3';

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  preferredTransport: string;
  provider?: { organization?: string; url?: string };
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
  }>;
  securitySchemes?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Builds the A2A Agent Card from the `a2a.card` config block.
 * Config is truth: nothing here is inferred from the agent's internals.
 */
export function buildAgentCard(config: A2aConfig, baseUrl: string): AgentCard {
  const c = config.card;
  if (!c) throw new Error('a2a.card config is required to serve an Agent Card');

  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: c.name,
    description: c.description,
    url: baseUrl,
    version: c.version ?? '0.0.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };

  if (c.provider) card.provider = c.provider;
  if (c.skills) {
    card.skills = c.skills.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      description: s.description,
      tags: s.tags ?? [],
      examples: s.examples ?? [],
    }));
  }
  if (c.securitySchemes) card.securitySchemes = c.securitySchemes;
  if (c.policies) card['x-policies'] = c.policies;

  return card;
}
