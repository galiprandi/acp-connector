import { describe, expect, it } from 'vitest';
import { detectAgents, KNOWN_AGENTS, parseWhichOutput } from '../src/setup/agents.ts';

describe('parseWhichOutput', () => {
  it('returns the first non-empty line', () => {
    expect(parseWhichOutput('/usr/local/bin/devin\n')).toBe('/usr/local/bin/devin');
  });

  it('handles multi-line `where` output (Windows)', () => {
    const out = 'C:\\tools\\opencode.exe\r\nC:\\other\\opencode.exe\r\n';
    expect(parseWhichOutput(out)).toBe('C:\\tools\\opencode.exe');
  });

  it('returns null for empty or whitespace-only output', () => {
    expect(parseWhichOutput('')).toBeNull();
    expect(parseWhichOutput('   \n  ')).toBeNull();
  });
});

describe('detectAgents', () => {
  const whichAll = () => '/fake/bin/agent';
  const whichNone = () => null;
  const noFiles = () => false;

  it('returns empty when nothing is in PATH', () => {
    expect(detectAgents(whichNone)).toEqual([]);
  });

  it('detects every known agent when all are in PATH', () => {
    const found = detectAgents(whichAll, noFiles, '/home/u');
    expect(found).toHaveLength(KNOWN_AGENTS.length);
    expect(found.map((f) => f.spec.bin)).toEqual(KNOWN_AGENTS.map((a) => a.bin));
    expect(found.every((f) => f.path === '/fake/bin/agent')).toBe(true);
  });

  it('detects only agents present in PATH', () => {
    const which = (bin: string) => (bin === 'claude' ? '/usr/bin/claude' : null);
    const found = detectAgents(which, noFiles);
    expect(found).toHaveLength(1);
    expect(found[0].spec.bin).toBe('claude');
  });

  it('flags looksLoggedIn when a login hint path exists', () => {
    const exists = (p: string) => p === '/home/u/.claude';
    const which = (bin: string) => (bin === 'claude' ? '/usr/bin/claude' : null);
    const found = detectAgents(which, exists, '/home/u');
    expect(found[0].looksLoggedIn).toBe(true);
  });

  it('does not flag looksLoggedIn without hint files', () => {
    const which = (bin: string) => (bin === 'devin' ? '/usr/bin/devin' : null);
    const found = detectAgents(which, noFiles, '/home/u');
    expect(found[0].looksLoggedIn).toBe(false);
  });
});

describe('agent spec non-interactive args', () => {
  const prompt = 'run the setup skill';

  it('claude uses -p with the prompt', () => {
    const claude = KNOWN_AGENTS.find((a) => a.bin === 'claude');
    expect(claude?.nonInteractiveArgs(prompt)).toEqual(['-p', prompt]);
  });

  it('opencode uses `run` with the prompt', () => {
    const opencode = KNOWN_AGENTS.find((a) => a.bin === 'opencode');
    expect(opencode?.nonInteractiveArgs(prompt)).toEqual(['run', prompt]);
  });

  it('agents without a one-shot mode return null', () => {
    const devin = KNOWN_AGENTS.find((a) => a.bin === 'devin');
    expect(devin?.nonInteractiveArgs(prompt)).toBeNull();
  });

  it('every spec has an install URL and agentCmd', () => {
    for (const a of KNOWN_AGENTS) {
      expect(a.installUrl).toMatch(/^https?:\/\//);
      expect(a.agentCmd.length).toBeGreaterThan(0);
    }
  });
});
