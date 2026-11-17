import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BridgeConfig,
  defaultConfigPath,
  loadConfig,
  persistSessionId,
  saveConfig,
} from '../src/config.ts';

const tmpConfigPath: string = resolve(process.cwd(), 'acp-connector.jsonc');

const validConfig: BridgeConfig = {
  agentCmd: 'acp-agent serve',
  platforms: { telegram: { token: 'tok', allowedChatIds: [123] } },
};

describe('config', () => {
  afterEach(() => {
    if (existsSync(tmpConfigPath)) rmSync(tmpConfigPath);
  });

  it('returns null when no config file exists', () => {
    expect(loadConfig()).toBeNull();
  });

  it('loads a simple config', () => {
    writeFileSync(tmpConfigPath, JSON.stringify(validConfig));
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
    expect(cfg?.platforms?.telegram?.allowedChatIds).toEqual([123]);
  });

  it('strips line comments', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  // agent command
  "agentCmd": "acp-agent serve",
  "platforms": { "telegram": { "token": "tok", "allowedChatIds": [123] } }
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
  });

  it('strips block comments', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  /* block comment */
  "agentCmd": "acp-agent serve",
  "platforms": { "telegram": { "token": "tok", "allowedChatIds": [123] } }
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
  });

  it('strips trailing commas', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  "agentCmd": "acp-agent serve",
  "platforms": { "telegram": { "token": "tok", "allowedChatIds": [123,] } },
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.platforms?.telegram?.allowedChatIds).toEqual([123]);
  });

  it('does not strip // inside strings', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  "agentCmd": "https://example.com",
  "platforms": { "telegram": { "token": "tok", "allowedChatIds": [123] } }
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('https://example.com');
  });

  it('saveConfig writes valid JSON', () => {
    saveConfig(validConfig);
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
  });

  it('defaultConfigPath resolves to cwd', () => {
    expect(defaultConfigPath).toBe(resolve(process.cwd(), 'acp-connector.jsonc'));
  });

  it('persistSessionId writes sessionId and preserves other fields', () => {
    writeFileSync(tmpConfigPath, JSON.stringify(validConfig));
    persistSessionId('sess-123');
    const cfg = loadConfig();
    expect(cfg?.sessionId).toBe('sess-123');
    expect(cfg?.agentCmd).toBe('acp-agent serve');
    expect(cfg?.platforms?.telegram?.token).toBe('tok');
  });

  it('persistSessionId skips the write when the id is unchanged', () => {
    writeFileSync(tmpConfigPath, JSON.stringify({ ...validConfig, sessionId: 'same-id' }));
    const before = loadConfig();
    persistSessionId('same-id');
    const after = loadConfig();
    expect(after?.sessionId).toBe('same-id');
    expect(after).toEqual(before);
  });

  it('persistSessionId is a no-op when no config file exists', () => {
    expect(() => persistSessionId('sess-123')).not.toThrow();
    expect(existsSync(tmpConfigPath)).toBe(false);
  });

  it('persistSessionId does not throw on an invalid config', () => {
    writeFileSync(tmpConfigPath, '{ invalid json');
    expect(() => persistSessionId('sess-123')).not.toThrow();
  });
});
