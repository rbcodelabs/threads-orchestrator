/**
 * Leads every prompt sent to an orchestrator (heartbeats and wake-ups). The
 * skill body is the single source of the detailed rules; the prompts only
 * make sure the orchestrator loads it before acting.
 */
export const LOAD_SKILL_INSTRUCTION = 'First load the thread-orchestrator skill.';
