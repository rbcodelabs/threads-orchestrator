import { describe, expect, it, vi } from 'vitest';
import { OrchestratorSettingsModel } from '../OrchestratorSettingsModel';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot } from '../ClaudeThreadsApiTypes';

const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'tp', title: 'Portfolio Orchestrator' } as OrchestratorSnapshot;
const on = { id: 'project:a', kind: 'project', projectId: 'a', threadId: 'ta', title: 'A Orchestrator', enabled: true } as OrchestratorSnapshot;
const off = { id: 'project:b', kind: 'project', projectId: 'b', threadId: '', title: 'B Orchestrator', enabled: false } as OrchestratorSnapshot;

function setup(list: OrchestratorSnapshot[] = [portfolio, on, off]) {
  const open = vi.fn(async () => {});
  const ensure = vi.fn(async (t: { id: string }) => ({ ...(list.find(o => o.id === t.id) ?? on), id: t.id, threadId: `new-${t.id}`, enabled: true }) as OrchestratorSnapshot);
  const setEnabled = vi.fn(async (t: { id: string }, enabled: boolean) => ({ ...(list.find(o => o.id === t.id) as OrchestratorSnapshot), enabled }));
  const api = { threads: { open }, orchestrators: { list: vi.fn(async () => list), ensure, setEnabled } } as unknown as ClaudeThreadsApiV1;
  return { model: new OrchestratorSettingsModel({ current: () => api }), open, ensure, setEnabled, api };
}

describe('OrchestratorSettingsModel', () => {
  it('maps list() to rows: Portfolio is never toggleable; Projects expose enabled state and thread presence', async () => {
    const { model } = setup();
    expect(await model.rows()).toEqual([
      { id: 'portfolio', kind: 'portfolio', title: 'Portfolio Orchestrator', enabled: true, canToggle: false, hasThread: true },
      { id: 'project:a', kind: 'project', title: 'A Orchestrator', enabled: true, canToggle: true, hasThread: true },
      { id: 'project:b', kind: 'project', title: 'B Orchestrator', enabled: false, canToggle: true, hasThread: false },
    ]);
  });

  it('always shows a Portfolio row (no thread) when list() does not include one', async () => {
    const { model } = setup([on]);
    expect((await model.rows())![0]).toEqual({ id: 'portfolio', kind: 'portfolio', title: 'Portfolio Orchestrator', enabled: true, canToggle: false, hasThread: false });
  });

  it('open refuses to open an empty thread id', async () => {
    const { model, ensure, open } = setup();
    ensure.mockResolvedValueOnce({ id: 'project:b', kind: 'project', threadId: '', title: 'B', enabled: true } as OrchestratorSnapshot);
    await expect(model.openOrchestrator('project:b')).rejects.toThrow(/no thread/);
    expect(open).not.toHaveBeenCalled();
  });

  it('returns null rows when the API is unavailable', async () => {
    expect(await new OrchestratorSettingsModel({ current: () => null }).rows()).toBeNull();
  });

  it('setEnabled forwards to orchestrators.setEnabled and refuses the Portfolio', async () => {
    const { model, setEnabled } = setup();
    await model.setProjectEnabled('project:b', true);
    expect(setEnabled).toHaveBeenCalledWith({ id: 'project:b' }, true);
    await expect(model.setProjectEnabled('portfolio', false)).rejects.toThrow(/Portfolio/);
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });

  it('open ensures the orchestrator exists, then opens the returned thread', async () => {
    const { model, ensure, open } = setup();
    await model.openOrchestrator('project:b');
    expect(ensure).toHaveBeenCalledWith({ id: 'project:b' });
    expect(open).toHaveBeenCalledWith('new-project:b');
  });

  it('open does not open anything when ensure fails', async () => {
    const { model, ensure, open } = setup();
    ensure.mockRejectedValueOnce(new Error('ensure failed'));
    await expect(model.openOrchestrator('portfolio')).rejects.toThrow('ensure failed');
    expect(open).not.toHaveBeenCalled();
  });
});
