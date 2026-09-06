import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigPath, loadConfig, saveConfig } from '../src/config.js';

const tmpConfigPath = resolve(process.cwd(), '.config.jsonc');

describe('config', () => {
  afterEach(() => {
    if (existsSync(tmpConfigPath)) rmSync(tmpConfigPath);
  });

  it('returns null when no config file exists', () => {
    expect(loadConfig()).toBeNull();
  });

  it('loads a simple config', () => {
    writeFileSync(
      tmpConfigPath,
      JSON.stringify({ agentCmd: 'acp-agent serve', telegramToken: 'tok', allowedChatIds: [123] })
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.agentCmd).toBe('acp-agent serve');
    expect(cfg.allowedChatIds).toEqual([123]);
  });

  it('strips line comments', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  // agent command
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok",
  "allowedChatIds": [123]
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.agentCmd).toBe('acp-agent serve');
  });

  it('strips block comments', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  /* block comment */
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok",
  "allowedChatIds": [123]
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.agentCmd).toBe('acp-agent serve');
  });

  it('strips trailing commas', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok",
  "allowedChatIds": [123,],
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.allowedChatIds).toEqual([123]);
  });

  it('does not strip // inside strings', () => {
    writeFileSync(
      tmpConfigPath,
      `{
  "agentCmd": "https://example.com",
  "telegramToken": "tok",
  "allowedChatIds": [123]
}`
    );
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.agentCmd).toBe('https://example.com');
  });

  it('saveConfig writes valid JSON', () => {
    saveConfig({ agentCmd: 'acp-agent serve', telegramToken: 'tok', allowedChatIds: [123] });
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg.agentCmd).toBe('acp-agent serve');
  });

  it('defaultConfigPath resolves to cwd', () => {
    expect(defaultConfigPath).toBe(resolve(process.cwd(), '.config.jsonc'));
  });
});
