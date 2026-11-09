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
    const rows: OrchestratorRow[] = (await api.orchestrators.list()).map(o => ({
      id: o.id, kind: o.kind, title: o.title, enabled: o.enabled !== false,
      canToggle: o.kind === 'project', hasThread: !!o.threadId,
    }));
    // list() may omit a Portfolio orchestrator that was never created; always offer it.
    if (!rows.some(r => r.kind === 'portfolio')) rows.unshift({ id: 'portfolio', kind: 'portfolio', title: 'Portfolio Orchestrator', enabled: true, canToggle: false, hasThread: false });
    return rows;
  }

  async setProjectEnabled(id: string, enabled: boolean): Promise<void> {
    if (id === 'portfolio') throw new Error('The Portfolio orchestrator cannot be disabled.');
    await this.requireApi().orchestrators.setEnabled({ id }, enabled);
  }

  /** Creates the orchestrator if needed (re-enabling a disabled Project), then opens its thread. */
  async openOrchestrator(id: string): Promise<void> {
    const api = this.requireApi();
    const snapshot = await api.orchestrators.ensure({ id });
    if (!snapshot.threadId) throw new Error('The orchestrator has no thread to open.');
    await api.threads.open(snapshot.threadId);
  }

  private requireApi(): ClaudeThreadsApiV1 {
    const api = this.client.current();
    if (!api) throw new Error('Agent Threads is unavailable.');
    return api;
  }
}
