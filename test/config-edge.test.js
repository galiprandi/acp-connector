import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';

const validConfig = {
  agentCmd: 'acp-agent serve',
  telegramToken: 'tok',
  allowedChatIds: [123],
};

describe('config edge cases', () => {
  let tmpDir;
  let cfgPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-cfg-edge-'));
    cfgPath = join(tmpDir, 'test.config.jsonc');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCfg(content) {
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

  it('missing required fields (no telegramToken) throws a validation error', () => {
    writeCfg(JSON.stringify({ agentCmd: 'acp-agent serve', allowedChatIds: [123] }));
    expect(() => loadConfig(cfgPath)).toThrow(/telegramToken/i);
  });

  it('missing required fields (no allowedChatIds) throws a validation error', () => {
    writeCfg(JSON.stringify({ agentCmd: 'acp-agent serve', telegramToken: 'tok' }));
    expect(() => loadConfig(cfgPath)).toThrow(/allowedChatIds/i);
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
    expect(cfg.agentCmd).toBe('acp-agent serve');
    expect(cfg.unknownField).toBe('hello');
    expect(cfg.another).toEqual({ nested: true });
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
    expect(cfg.allowedChatIds).toEqual([123]);
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
    expect(cfg.agentCmd).toBe('acp-agent serve');
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
    expect(cfg.agentCmd).toBe('acp-agent serve');
  });

  it('saveConfig with null/undefined throws a clear error', () => {
    expect(() => saveConfig(null, cfgPath)).toThrow();
    expect(() => saveConfig(undefined, cfgPath)).toThrow();
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('saveConfig with empty object writes a file that loads as null', () => {
    saveConfig({}, cfgPath);
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
    const nested = join(tmpDir, 'sub', 'deep', 'test.config.jsonc');
    expect(() => saveConfig(validConfig, nested)).toThrow();
  });

  it('loadConfig on non-existent path returns null', () => {
    expect(loadConfig(join(tmpDir, 'nope.jsonc'))).toBeNull();
  });

  it('allowedChatIds as non-array throws validation error', () => {
    writeCfg(
      JSON.stringify({ agentCmd: 'acp-agent serve', telegramToken: 'tok', allowedChatIds: 123 })
    );
    expect(() => loadConfig(cfgPath)).toThrow(/allowedChatIds/i);
  });
});
