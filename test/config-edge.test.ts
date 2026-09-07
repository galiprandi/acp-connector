import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BridgeConfig, loadConfig, saveConfig } from '../src/config.ts';

const validConfig: BridgeConfig = {
  agentCmd: 'acp-agent serve',
  platforms: {
    telegram: {
      token: 'tok',
      allowedChatIds: [123],
    },
  },
};

describe('config edge cases', () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-cfg-edge-'));
    cfgPath = join(tmpDir, 'test.acp-connector.jsonc');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCfg(content: string): void {
    writeFileSync(cfgPath, content, 'utf8');
  }

  it('empty file (0 bytes) returns null instead of throwing', () => {
    writeCfg('');
    expect(loadConfig(cfgPath)).toBeNull();
  });

  it('file with only comments returns null instead of throwing', () => {
    writeCfg(
      `// just a comment
/* another comment */
// nothing else`
    );
    expect(loadConfig(cfgPath)).toBeNull();
  });

  it('file with only whitespace returns null', () => {
    writeCfg('   \n\t  \n');
    expect(loadConfig(cfgPath)).toBeNull();
  });

  it('invalid JSON (syntax error) throws a clear, rethrown error', () => {
    writeCfg('{ "agentCmd": "acp-agent serve", broken }');
    expect(() => loadConfig(cfgPath)).toThrow();
  });

  it('missing required fields (no agentCmd) throws a validation error', () => {
    writeCfg(JSON.stringify({ telegramToken: 'tok', allowedChatIds: [123] }));
    expect(() => loadConfig(cfgPath)).toThrow(/agentCmd/i);
  });

  it('missing required fields (no platforms or telegramToken) throws a validation error', () => {
    writeCfg(JSON.stringify({ agentCmd: 'acp-agent serve' }));
    expect(() => loadConfig(cfgPath)).toThrow(/platforms\.telegram|telegramToken/i);
  });

  it('missing allowedChatIds in platforms.telegram defaults to empty array', () => {
    writeCfg(
      JSON.stringify({ agentCmd: 'acp-agent serve', platforms: { telegram: { token: 'tok' } } })
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg?.platforms?.telegram?.allowedChatIds).toEqual([]);
  });

  it('extra unknown fields are preserved safely', () => {
    writeCfg(
      JSON.stringify({
        ...validConfig,
        unknownField: 'hello',
        another: { nested: true },
      })
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
    expect((cfg as Record<string, unknown>).unknownField).toBe('hello');
    expect((cfg as Record<string, unknown>).another).toEqual({ nested: true });
  });

  it('file with trailing comma (invalid JSONC) is accepted', () => {
    writeCfg(
      `{
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok",
  "allowedChatIds": [123,],
}`
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg).not.toBeNull();
    expect(cfg?.allowedChatIds).toEqual([123]);
  });

  it('file with block comments is parsed', () => {
    writeCfg(
      `{
  /* this is a
     multi-line block comment */
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok",
  "allowedChatIds": [123]
}`
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
  });

  it('file with line comments is parsed', () => {
    writeCfg(
      `{
  // the agent command
  "agentCmd": "acp-agent serve",
  "telegramToken": "tok", // the token
  "allowedChatIds": [123]
}`
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg).not.toBeNull();
    expect(cfg?.agentCmd).toBe('acp-agent serve');
  });

  it('saveConfig with null/undefined throws a clear error', () => {
    expect(() => saveConfig(null as unknown as BridgeConfig, cfgPath)).toThrow();
    expect(() => saveConfig(undefined as unknown as BridgeConfig, cfgPath)).toThrow();
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('saveConfig with empty object writes a file that loads as null', () => {
    saveConfig({} as BridgeConfig, cfgPath);
    expect(existsSync(cfgPath)).toBe(true);
    // empty object has no required fields -> validation throws on load
    expect(() => loadConfig(cfgPath)).toThrow();
  });

  it('saveConfig then loadConfig round-trips a valid config', () => {
    saveConfig(validConfig, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect(cfg).not.toBeNull();
    expect(cfg).toEqual(validConfig);
  });

  it('saveConfig writes to a path inside a non-existent nested dir fails predictably', () => {
    const nested: string = join(tmpDir, 'sub', 'deep', 'test.acp-connector.jsonc');
    expect(() => saveConfig(validConfig, nested)).toThrow();
  });

  it('loadConfig on non-existent path returns null', () => {
    expect(loadConfig(join(tmpDir, 'nope.jsonc'))).toBeNull();
  });

  it('legacy telegramToken without platforms migrates to platforms format', () => {
    writeCfg(
      JSON.stringify({ agentCmd: 'acp-agent serve', telegramToken: 'tok', allowedChatIds: [123] })
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg?.platforms?.telegram?.token).toBe('tok');
    expect(cfg?.platforms?.telegram?.allowedChatIds).toEqual([123]);
  });
});
