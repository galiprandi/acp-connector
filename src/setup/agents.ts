import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent detection table for the assistant-setup wizard.
 *
 * Each entry describes a known agent CLI: how to find it in PATH, how to
 * launch it non-interactively with an initial prompt, and which files hint
 * at an existing login/session so the wizard can flag "looks logged in".
 */

export interface AgentSpec {
  /** CLI binary name looked up in PATH. */
  bin: string;
  /** Human-readable name. */
  name: string;
  /** Install page shown when no agent is found at all. */
  installUrl: string;
  /**
   * Build the argv to run the agent non-interactively with `prompt`.
   * Return null when the agent has no known non-interactive mode — the
   * wizard then launches it interactively and prints the prompt for the
   * user to paste.
   */
  nonInteractiveArgs: (prompt: string) => string[] | null;
  /** Paths (relative to home) whose presence suggests a logged-in session. */
  loginHints: string[];
  /** acp-connector `agentCmd` value to write into generated config. */
  agentCmd: string;
}

export const KNOWN_AGENTS: AgentSpec[] = [
  {
    bin: 'devin',
    name: 'Devin',
    installUrl: 'https://docs.devin.ai/cli',
    // `devin acp` is an interactive ACP session — no single-shot flag.
    nonInteractiveArgs: () => null,
    loginHints: ['.config/devin', '.devin'],
    agentCmd: 'devin acp',
  },
  {
    bin: 'claude',
    name: 'Claude Code',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    nonInteractiveArgs: (prompt) => ['-p', prompt],
    loginHints: ['.claude', '.claude.json'],
    agentCmd: 'claude acp',
  },
  {
    bin: 'opencode',
    name: 'OpenCode',
    installUrl: 'https://opencode.ai/docs/',
    nonInteractiveArgs: (prompt) => ['run', prompt],
    loginHints: ['.local/share/opencode', '.config/opencode'],
    agentCmd: 'opencode acp',
  },
  {
    bin: 'agy',
    name: 'Antigravity',
    installUrl: 'https://antigravity.dev/',
    nonInteractiveArgs: () => null,
    loginHints: ['.config/agy', '.agy'],
    agentCmd: 'agy acp',
  },
  {
    bin: 'pi',
    name: 'pi',
    installUrl: 'https://github.com/Badhansen/pi',
    nonInteractiveArgs: () => null,
    loginHints: ['.config/pi'],
    agentCmd: 'pi acp',
  },
];

export interface DetectedAgent {
  spec: AgentSpec;
  /** Absolute path resolved from PATH lookup. */
  path: string;
  /** Best-effort: a login/session file exists under home. */
  looksLoggedIn: boolean;
}

export type WhichFn = (bin: string) => string | null;
export type ExistsFn = (path: string) => boolean;

/**
 * Default PATH lookup: `which` on POSIX, `where` on Windows.
 * Returns the first resolved path or null. Injectable for tests.
 */
export function defaultWhich(platform: NodeJS.Platform = process.platform): WhichFn {
  // Lazily imported so tests never spawn processes.
  return (bin) => {
    try {
      const cmd = platform === 'win32' ? `where ${bin}` : `which ${bin}`;
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return parseWhichOutput(out);
    } catch {
      return null;
    }
  };
}

/**
 * Parse `which`/`where` stdout into the first resolved path.
 * `where` may print several matches; empty output → null.
 */
export function parseWhichOutput(output: string): string | null {
  const first = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? null;
}

/**
 * Scan PATH for every known agent. `exists` checks login-hint paths and is
 * injectable for tests.
 */
export function detectAgents(
  which: WhichFn,
  exists: ExistsFn = existsSync,
  home: string = homedir()
): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const spec of KNOWN_AGENTS) {
    const path = which(spec.bin);
    if (!path) continue;
    const looksLoggedIn = spec.loginHints.some((hint) => exists(join(home, hint)));
    found.push({ spec, path, looksLoggedIn });
  }
  return found;
}
