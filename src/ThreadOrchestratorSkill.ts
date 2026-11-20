import type { SkillContribution } from './ClaudeThreadsApiTypes';
import body from './skills/thread-orchestrator.md';

/**
 * The thread-orchestrator skill (Option B: Goal-Bounded Campaign Manager).
 * Description leads with an explicit role directive so Portfolio and Project
 * orchestrator sessions self-select it reliably on direct messages as well as
 * wake-ups and heartbeats. Wake-up and heartbeat prompts also open with
 * "First load the thread-orchestrator skill." (see orchestratorPrompts.ts);
 * this body stays the single source of the detailed governance rules.
 */
export const THREAD_ORCHESTRATOR_SKILL: SkillContribution = {
  name: 'thread-orchestrator',
  description: 'Load first when this thread is the Portfolio or a Project orchestrator in Agent Threads, including on direct messages, event pings, and heartbeats. Acts as a Goal-Bounded Campaign Manager ("Manager, Never Worker"): delegates repository work to visible Agent Board worker threads, coordinates multi-thread campaigns with two-tier memory (Manager notes v2 and orchestrator-ledger.md), uses the 5-channel action contract, and stages replies or posts decisions for Rick without approving proposals or irreversible actions itself.',
  content: body,
};
