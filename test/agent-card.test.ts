import { describe, expect, it } from 'vitest';
import { buildAgentCard } from '../src/agent-card.ts';
import type { A2aConfig } from '../src/config.ts';

const baseConfig: A2aConfig = {
  enabled: true,
  card: {
    name: 'Donna',
    description: 'Personal assistant',
    skills: [
      {
        id: 'wa.send',
        name: 'Send WhatsApp',
        description: 'Send a WhatsApp message on behalf of the owner',
      },
    ],
  },
};

describe('buildAgentCard', () => {
  it('produces a spec-shaped card', () => {
    const card = buildAgentCard(baseConfig, 'http://localhost:7741');
    expect(card.name).toBe('Donna');
    expect(card.description).toBe('Personal assistant');
    expect(card.url).toBe('http://localhost:7741');
    expect(card.protocolVersion).toBeDefined();
    expect(card.version).toBeDefined();
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.skills).toHaveLength(1);
    expect(card.skills?.[0].id).toBe('wa.send');
  });

  it('includes declared security schemes', () => {
    const cfg: A2aConfig = {
      ...baseConfig,
      card: {
        ...baseConfig.card,
        securitySchemes: { peerHeader: { type: 'apiKey', in: 'header', name: 'X-A2A-Peer-Id' } },
      } as A2aConfig['card'],
    };
    const card = buildAgentCard(cfg, 'http://localhost:7741');
    expect(card.securitySchemes?.peerHeader).toMatchObject({ type: 'apiKey' });
  });

  it('throws when card config is missing', () => {
    expect(() => buildAgentCard({ enabled: true }, 'http://x')).toThrow(/card/i);
  });
});
