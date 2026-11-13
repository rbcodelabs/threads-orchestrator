import type { SkillContribution } from './ClaudeThreadsApiTypes';
import body from './skills/thread-orchestrator.md';

/**
 * The thread-orchestrator skill, moved here from Agent Threads core. Name and
 * description are identical to core's former SKILL.md frontmatter so the
 * orchestrator threads discover it the same way (by description). The wake-up
 * and heartbeat prompts open with "First load the thread-orchestrator skill."
 * (see orchestratorPrompts.ts) because listing the skill alone does not make an
 * orchestrator load it; this body stays the single source of the detailed rules.
 * If a host namespaces the registered id, update that instruction with it.
 */
export const THREAD_ORCHESTRATOR_SKILL: SkillContribution = {
  name: 'thread-orchestrator',
  description: 'Scoped orchestrator for Agent Threads. A Project orchestrator reviews its own Project; the Portfolio Orchestrator reviews unassigned work and Project-level summaries. Establishes goals, tracks progress, and stages replies for human approval without sending them itself.',
  content: body,
};
