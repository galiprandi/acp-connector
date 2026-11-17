/**
 * Agent registry for the e2e matrix. `agentCmd` is passed verbatim to
 * AcpClient — keep it a single shell-free command line.
 *
 * Capability notes (probed 2026-11):
 * - devin acp:    modes (accept-edits/smart/ask/plan/bypass) + configOptions
 *                 (mode, model, thought_level, speed), session/list+resume
 * - opencode acp: no availableModes; configOptions (model, effort, mode),
 *                 session/list+resume+close+fork
 * - dsh acp:      no modes; configOptions (model, reasoning_effort),
 *                 session/list; prompt needs DEEPSEEK_API_KEY (auto-skips)
 * - agy-acp:      modes (default/accept-edits/plan) + configOptions
 *                 (mode, model, reasoningEffort), session/list+resume
 */
export interface AgentSpec {
  id: string;
  agentCmd: string;
  /**
   * session/resume|load support: 'yes' restores the same id,
   * 'fallback' means resume fails and a fresh session is created
   * (the bridge must degrade gracefully, never fail to boot).
   */
  resume?: 'yes' | 'fallback';
}

export const AGENTS: AgentSpec[] = [
  { id: 'devin', agentCmd: 'devin acp', resume: 'yes' },
  { id: 'opencode', agentCmd: 'opencode acp', resume: 'yes' },
  // dsh acp has no session/resume|load — resumeSessionId fails and the
  // client falls back to session/new (verified: Internal error → new id).
  { id: 'dsh', agentCmd: 'dsh acp', resume: 'fallback' },
  { id: 'agy', agentCmd: 'npx agy-acp', resume: 'yes' },
];

/** Filter via ACP_MATRIX_AGENTS=devin,opencode (comma-separated ids). */
export function selectedAgents(): AgentSpec[] {
  const filter = process.env.ACP_MATRIX_AGENTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!filter || filter.length === 0) return AGENTS;
  return AGENTS.filter((a) => filter.includes(a.id));
}
