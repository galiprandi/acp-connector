import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpClient } from '../../../src/acp-client.js';
import { type AgentSpec, selectedAgents } from './agents.js';
import { type AgentRuntime, bootAgent, shutdownAgent } from './harness.js';

/**
 * E2E agent matrix — runs the real bridge command surface against real
 * ACP agents. Opt-in only (never part of `pnpm test`):
 *
 *   pnpm test:matrix                          # all detected agents
 *   ACP_MATRIX_AGENTS=devin,opencode pnpm test:matrix
 *
 * Agents that fail to boot are reported as skipped; agents whose LLM
 * credentials are missing run every check except prompt round-trips
 * (e.g. dsh acp without its OpenRouter/DeepSeek credential patch).
 */

const RUN = process.env.ACP_MATRIX === '1' || process.env.ACP_MATRIX === 'true';
const agents = selectedAgents();
const cwd = mkdtempSync(join(tmpdir(), 'acp-matrix-cwd-'));

interface Cell {
  spec: AgentSpec;
  rt: AgentRuntime | null;
  bootError?: string;
}

const cells = new Map<string, Cell>();

async function setup() {
  for (const spec of agents) {
    const rt = await bootAgent(spec.agentCmd, cwd);
    cells.set(spec.id, rt ? { spec, rt } : { spec, rt: null, bootError: 'agent failed to start' });
    console.log(
      `[matrix] ${spec.id}: ${rt ? `up (prompt=${rt.promptCapable ? 'yes' : 'NO — creds?'})` : 'UNAVAILABLE'}`
    );
  }
}

function cell(id: string): Cell {
  const c = cells.get(id);
  if (!c) throw new Error(`unknown agent ${id}`);
  return c;
}

describe.skipIf(!RUN)('e2e agent matrix', () => {
  beforeAll(setup, 600_000);
  afterAll(() => {
    for (const c of cells.values()) {
      if (c.rt) shutdownAgent(c.rt);
    }
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);

  for (const spec of agents) {
    describe(spec.id, () => {
      it('boots with an ACP session and reports its id', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        expect(c.rt.sessionId).toBeTruthy();
        expect(c.rt.acp.sessionId).toBe(c.rt.sessionId);
      });

      it('answers a trivial prompt', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        if (!c.rt.promptCapable) return ctx.skip();
        const res = await c.rt.bot.prompt('Reply with exactly: MATRIX_OK', 90_000);
        expect(res).toContain('MATRIX_OK');
      }, 120_000);

      it('/sessions lists and /sessions <n> resolves against the cached list', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const list = await c.rt.bot.cmd('/sessions');
        const text = list.map((m) => m.text ?? '').join('\n');
        // Either a numbered list or a graceful capability message.
        expect(text).toMatch(/Sessions:|No sessions|Cannot list sessions/);
        // Numeric ref resolves against the cached list — success or a
        // graceful resolution error, never a crash.
        const out = await c.rt.bot.cmd('/sessions 1');
        expect(out.map((m) => m.text ?? '').join('\n').length).toBeGreaterThan(0);
      }, 120_000);

      it('/sessions new starts a fresh session', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const before = c.rt.acp.sessionId;
        const fresh = await c.rt.bot.cmd('/sessions new');
        const freshText = fresh.map((m) => m.text ?? '').join('\n');
        expect(freshText).toMatch(/new session|Session|started/i);
        expect(c.rt.acp.sessionId).toBeTruthy();
        expect(c.rt.acp.sessionId).not.toBe(before);
      }, 120_000);

      it('/config lists options and /config <id> shows detail', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const list = await c.rt.bot.cmd('/config');
        const text = list.map((m) => m.text ?? '').join('\n');
        if (c.rt.configOptionIds.length === 0) {
          expect(text).toContain('No config options');
          return;
        }
        expect(text).toContain('Config options');
        for (const id of c.rt.configOptionIds) {
          expect(text).toContain(`\`${id}\``);
        }
        const detail = await c.rt.bot.cmd(`/config ${c.rt.configOptionIds[0]}`);
        const detailText = detail.map((m) => m.text ?? '').join('\n');
        expect(detailText.length).toBeGreaterThan(0);
      }, 60_000);

      it('/config mode resolves per capability profile', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/config mode');
        const text = out.map((m) => m.text ?? '').join('\n');
        if (c.rt.modeOptionKind === 'none') {
          expect(text).toContain('Unknown option');
        } else {
          // Real config option or synthetic — either way `mode` must resolve.
          expect(text).not.toContain('Unknown option');
          expect(text.length).toBeGreaterThan(0);
        }
      }, 60_000);

      it('/time shows host, config and UTC clocks', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/time');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text).toContain('Host:');
        expect(text).toContain('UTC:');
      });

      it('/status reports agent state', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/status');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text).toContain('agent:');
        expect(text).toContain('session:');
        expect(text).toContain('acp-connector');
        expect(text).toContain('up ');
      });

      it('/queue lists the pending queue', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/queue');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text.length).toBeGreaterThan(0);
      });

      it('/stop with nothing running reports idle', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/stop');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text).toContain('Nothing to stop');
      });

      it('/help lists the unified command surface', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/help');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text).toContain('acp-connector');
        for (const cmd of ['/sessions', '/config', '/queue', '/jobs', '/time', '/status']) {
          expect(text).toContain(cmd);
        }
        // Removed bridge commands must not appear in the BUILT-IN help —
        // agent-advertised commands (e.g. agy's own /mode, /model) are
        // legitimate and listed under *Agent commands:*.
        const builtin = text.split('*Agent commands:*')[0];
        for (const gone of ['/cron', '/routine', '/reminder', '/run ', '/model', '/mode ']) {
          expect(builtin).not.toContain(gone);
        }
      });

      it('/jobs manual job lifecycle: add → list → rm', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const name = `mx-${spec.id}-${Date.now() % 100000}`;
        const add = await c.rt.bot.cmd(`/jobs add as ${name} manual matrix probe`);
        expect(add.map((m) => m.text ?? '').join('\n')).not.toContain('Could not parse');
        const list = await c.rt.bot.cmd('/jobs');
        expect(list.map((m) => m.text ?? '').join('\n')).toContain(name);
        const rm = await c.rt.bot.cmd(`/jobs rm ${name}`);
        expect(rm.map((m) => m.text ?? '').join('\n').length).toBeGreaterThan(0);
        const after = await c.rt.bot.cmd('/jobs');
        expect(after.map((m) => m.text ?? '').join('\n')).not.toContain(name);
      }, 60_000);

      it('/jobs once job is listed with a fire time', async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        const out = await c.rt.bot.cmd('/jobs add in 1h matrix once probe');
        const text = out.map((m) => m.text ?? '').join('\n');
        expect(text.length).toBeGreaterThan(0);
        const list = await c.rt.bot.cmd('/jobs');
        const listText = list.map((m) => m.text ?? '').join('\n');
        expect(listText).toContain('matrix once probe');
        // cleanup: remove the probe job by name-less ref — find its id via state
        const jobs = (c.rt.bot.store.get('jobs') as Array<{ id: string; prompt: string }>) ?? [];
        const probe = jobs.find((j) => j.prompt === 'matrix once probe');
        if (probe) c.rt.bot.jobs.remove(probe.id);
      }, 60_000);
    });
  }

  // Session restore is a cross-boot property — one check per agent.
  describe('session restore', () => {
    for (const spec of agents) {
      it(`${spec.id}: resume restores the stored sessionId`, async (ctx) => {
        const c = cell(spec.id);
        if (!c.rt) return ctx.skip();
        // Ensure the session has real content: some agents (devin) only
        // persist sessions that completed a turn — an empty session made
        // by '/sessions new' is legitimately unresumable after restart.
        if (c.rt.promptCapable) {
          await c.rt.bot.prompt('Reply with exactly: RESUME_PROBE', 90_000);
        }
        const stored = c.rt.acp.sessionId;
        // Simulate a bridge restart: kill the old agent process before
        // the new one resumes — some agents (devin) refuse to resume a
        // session still open in another process, and flush the session
        // record asynchronously after exit. NOTE: do NOT session/close
        // first — devin removes closed sessions from the resumable set.
        c.rt.acp.kill();
        await new Promise((r) => setTimeout(r, 1500));
        // 'yes'-resume agents get retries: the agent may still be
        // flushing the closed session when the first resume arrives.
        const attempts = spec.resume === 'yes' ? 3 : 1;
        let acp2: AcpClient | null = null;
        try {
          for (let i = 0; i < attempts; i++) {
            acp2?.kill();
            acp2 = new AcpClient({ agentCmd: spec.agentCmd, agentCwd: cwd, sessionId: stored });
            await acp2.start();
            if (spec.resume !== 'yes' || acp2.sessionId === stored) break;
            await new Promise((r) => setTimeout(r, 3000));
          }
          if (spec.resume === 'fallback') {
            // No resume support — must degrade to a fresh session, not crash.
            expect(acp2?.sessionId).toBeTruthy();
          } else {
            expect(acp2?.sessionId).toBe(stored);
          }
        } finally {
          acp2?.kill();
        }
      }, 120_000);
    }
  });
});
