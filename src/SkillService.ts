import type { ClaudeThreadsApiV1, Disposable } from './ClaudeThreadsApiTypes';
import { THREAD_ORCHESTRATOR_SKILL } from './ThreadOrchestratorSkill';

export interface SkillServiceOptions { pluginId: string }

/** Registers the bundled skill with Agent Threads for the lifetime of one API generation. */
export class SkillService {
  private registration: Disposable | null = null;
  constructor(private readonly api: ClaudeThreadsApiV1, private readonly options: SkillServiceOptions) {}

  start(): void {
    if (this.registration) return;
    this.registration = this.api.extensions.registerSkill({ pluginId: this.options.pluginId }, THREAD_ORCHESTRATOR_SKILL);
  }

  stop(): void {
    const registration = this.registration;
    this.registration = null;
    registration?.dispose();
  }
}
