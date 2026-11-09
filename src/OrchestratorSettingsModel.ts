import type { ClaudeThreadsApiV1 } from './ClaudeThreadsApiTypes';

export interface OrchestratorRow {
  readonly id: string;
  readonly kind: 'portfolio' | 'project';
  readonly title: string;
  readonly enabled: boolean;
  /** The Portfolio orchestrator cannot be disabled. */
  readonly canToggle: boolean;
  readonly hasThread: boolean;
}

interface ApiSource { current(): ClaudeThreadsApiV1 | null }

/** UI-independent logic behind Settings -> Orchestrators. */
export class OrchestratorSettingsModel {
  constructor(private readonly client: ApiSource) {}

  async rows(): Promise<OrchestratorRow[] | null> {
    const api = this.client.current();
    if (!api) return null;
    return (await api.orchestrators.list()).map(o => ({
      id: o.id, kind: o.kind, title: o.title, enabled: o.enabled !== false,
      canToggle: o.kind === 'project', hasThread: !!o.threadId,
    }));
  }

  async setProjectEnabled(id: string, enabled: boolean): Promise<void> {
    if (id === 'portfolio') throw new Error('The Portfolio orchestrator cannot be disabled.');
    await this.requireApi().orchestrators.setEnabled({ id }, enabled);
  }

  /** Creates the orchestrator if needed (re-enabling a disabled Project), then opens its thread. */
  async openOrchestrator(id: string): Promise<void> {
    const api = this.requireApi();
    const snapshot = await api.orchestrators.ensure({ id });
    await api.threads.open(snapshot.threadId);
  }

  private requireApi(): ClaudeThreadsApiV1 {
    const api = this.client.current();
    if (!api) throw new Error('Agent Threads is unavailable.');
    return api;
  }
}
