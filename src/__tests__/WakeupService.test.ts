import { describe, expect, it, vi } from 'vitest';
import { WakeupService } from '../WakeupService';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const HEADER_1 = 'New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.';
const HEADER_2 = 'New activity on 2 threads. Review only the named changed threads; do not run a full reconciliation. The heartbeat handles missed activity.';

interface ThreadFixture { title?: string; projectId?: string; updatedAt?: number }

function busyError() { return Object.assign(new Error('busy'), { code: 'THREAD_BUSY' }); }
function notFoundError() { return Object.assign(new Error('nope'), { code: 'ORCHESTRATOR_NOT_FOUND' }); }
const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'orch-portfolio', title: 'Portfolio' } as OrchestratorSnapshot;

function setup(options: {
  threads?: Record<string, ThreadFixture>;
  orchestrators?: OrchestratorSnapshot[];
  dispatch?: (target: { id: string }, input: { prompt: string; queueIfBusy?: boolean }) => Promise<{ runId: string }>;
  debounceMs?: number;
} = {}) {
  let listener!: (event: PublicThreadEvent) => void;
  const threads = options.threads ?? {};
  const orchestrators = { current: options.orchestrators ?? [portfolio] };
  const dispatch = vi.fn(options.dispatch ?? (async () => ({ runId: 'r' })));
  const subscriptionDispose = vi.fn();
  const api = {
    apiVersion: 1, generation: 'g', capabilities: ['orchestrators.wakeup.delegate'],
    threads: {
      subscribe: vi.fn((fn: typeof listener) => { listener = fn; return { dispose: subscriptionDispose }; }),
      get: vi.fn(async (id: string) => threads[id] ? { id, title: threads[id].title ?? '', projectId: threads[id].projectId, updatedAt: threads[id].updatedAt ?? 1_700_000_000_000, messages: [] } : null),
    },
    orchestrators: { list: vi.fn(async () => orchestrators.current), dispatch },
  } as unknown as ClaudeThreadsApiV1;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const warn = vi.fn();
  const error = vi.fn();
  const service = new WakeupService(api, {
    debounceMs: options.debounceMs,
    setTimeoutFn: (cb, ms) => { callbacks.push(cb); delays.push(ms); return cb; },
    clearTimeoutFn: handle => { const i = callbacks.indexOf(handle as () => void); if (i >= 0) callbacks.splice(i, 1); },
    onWarn: warn, onError: error,
  });
  service.start();
  const emit = (event: { kind: PublicThreadEvent['kind']; threadId: string }) =>
    listener({ runId: 'r1', at: 1, error: { code: 'RUN_FAILED', message: 'boom' }, ...event } as PublicThreadEvent);
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const fire = async () => { const pending = callbacks.splice(0); pending.forEach(cb => cb()); await settle(); };
  return { api, service, emit, settle, fire, callbacks, delays, dispatch, warn, error, orchestrators, subscriptionDispose };
}

describe('WakeupService', () => {
  it('wakes the portfolio orchestrator with the exact single-thread message', async () => {
    const t = setup({ threads: { 'thread-1': { title: 'Fix login bug' } } });
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch).toHaveBeenCalledWith({ id: 'portfolio' }, {
      prompt: [HEADER_1, '- thread-1 "Fix login bug" (done; updatedAt=1700000000000)'].join('\n'),
      queueIfBusy: true,
    });
  });

  it('batches N finishes into one dispatch with plural wording and done/error status', async () => {
    const t = setup({ threads: { 'thread-1': { title: 'Fix login bug' }, 'thread-2': { title: 'Update docs' } } });
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    t.emit({ kind: 'run.failed', threadId: 'thread-2' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toBe([
      HEADER_2,
      '- thread-1 "Fix login bug" (done; updatedAt=1700000000000)',
      '- thread-2 "Update docs" (error; updatedAt=1700000000000)',
    ].join('\n'));
  });

  it('falls back to the bare id when the title is empty and to unavailable when the thread is gone', async () => {
    const t = setup({ threads: { 'thread-1': {} } });
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    await t.settle();
    (t.api.threads.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await t.fire();
    expect(t.dispatch.mock.calls[0][1].prompt).toBe(`${HEADER_1}\n- thread-1 (done; updatedAt=unavailable)`);
  });

  it('keeps only the most recent status when a thread fires twice before flush', async () => {
    const t = setup({ threads: { 'thread-1': { title: 'Flaky' } } });
    t.emit({ kind: 'run.failed', threadId: 'thread-1' });
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toBe(`${HEADER_1}\n- thread-1 "Flaky" (done; updatedAt=1700000000000)`);
  });

  it('ignores events other than run.completed and run.failed', async () => {
    const t = setup({ threads: { 'thread-1': { title: 'A' } } });
    t.emit({ kind: 'run.started', threadId: 'thread-1' });
    t.emit({ kind: 'message.completed', threadId: 'thread-1' });
    t.emit({ kind: 'thread.removed', threadId: 'thread-1' });
    await t.settle();
    expect(t.callbacks).toHaveLength(0);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('uses a 12 s debounce by default and honours an override', async () => {
    const def = setup({ threads: { a: {} } });
    def.emit({ kind: 'run.completed', threadId: 'a' });
    await def.settle();
    expect(def.delays).toEqual([12_000]);
    const custom = setup({ threads: { a: {} }, debounceMs: 500 });
    custom.emit({ kind: 'run.completed', threadId: 'a' });
    await custom.settle();
    expect(custom.delays).toEqual([500]);
  });

  it('does not wake for the portfolio orchestrator thread itself', async () => {
    const t = setup({ threads: { 'orch-portfolio': { title: 'Orchestrator' } } });
    t.emit({ kind: 'run.completed', threadId: 'orch-portfolio' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('routes Project threads to project:<id> and Project orchestrators to the portfolio', async () => {
    const t = setup({
      threads: { w: { title: 'Worker', projectId: 'p1' }, 'orch-p1': { title: 'P1 orch', projectId: 'p1' } },
      orchestrators: [
        portfolio,
        { id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled: true } as OrchestratorSnapshot,
      ],
    });
    t.emit({ kind: 'run.completed', threadId: 'w' });
    t.emit({ kind: 'run.completed', threadId: 'orch-p1' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id).sort()).toEqual(['portfolio', 'project:p1']);
    expect(t.dispatch.mock.calls.find(c => c[0].id === 'project:p1')![1].prompt).toContain('- w "Worker"');
    expect(t.dispatch.mock.calls.find(c => c[0].id === 'portfolio')![1].prompt).toContain('- orch-p1 "P1 orch"');
  });

  it('routes a thread with no projectId to the portfolio', async () => {
    const t = setup({ threads: { a: { title: 'A' } } });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls[0][0]).toEqual({ id: 'portfolio' });
  });

  it('ignores threads whose Project orchestrator is disabled, and treats missing enabled as true', async () => {
    const t = setup({
      threads: { w: { title: 'Worker', projectId: 'off' }, x: { title: 'Other', projectId: 'legacy' } },
      orchestrators: [
        portfolio,
        { id: 'project:off', kind: 'project', threadId: 'orch-off', projectId: 'off', title: 'Off', enabled: false } as OrchestratorSnapshot,
        { id: 'project:legacy', kind: 'project', threadId: 'orch-legacy', projectId: 'legacy', title: 'Legacy' } as OrchestratorSnapshot,
      ],
    });
    t.emit({ kind: 'run.completed', threadId: 'w' });
    t.emit({ kind: 'run.completed', threadId: 'x' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:legacy']);
  });

  it('re-reads orchestrators per event so a newly disabled Project stops waking', async () => {
    const t = setup({
      threads: { w: { title: 'Worker', projectId: 'p1' } },
      orchestrators: [{ id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled: true } as OrchestratorSnapshot],
    });
    t.orchestrators.current = [{ id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled: false } as OrchestratorSnapshot];
    t.emit({ kind: 'run.completed', threadId: 'w' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to a summary-only portfolio dispatch when the Project dispatch fails', async () => {
    const t = setup({
      threads: { w: { title: 'Sensitive task', projectId: 'p1' } },
      dispatch: async target => { if (target.id === 'project:p1') throw notFoundError(); return { runId: 'r' }; },
    });
    t.emit({ kind: 'run.failed', threadId: 'w' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.dispatch).toHaveBeenLastCalledWith({ id: 'portfolio' }, {
      prompt: 'New activity in Project p1 — the Project orchestrator could not be reached.',
      queueIfBusy: true,
    });
    expect(JSON.stringify(t.dispatch.mock.calls[1])).not.toContain('Sensitive task');
  });

  it('reports a failed portfolio dispatch via onError without throwing', async () => {
    const t = setup({ threads: { a: {} }, dispatch: async () => { throw new Error('down'); } });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    await t.fire();
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it('re-queues the batch on THREAD_BUSY and retries after the orchestrator next completes', async () => {
    let busy = true;
    const t = setup({
      threads: { a: { title: 'A' } },
      dispatch: async () => { if (busy) throw busyError(); return { runId: 'r' }; },
    });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.callbacks).toHaveLength(0); // no retry timer
    busy = false;
    t.emit({ kind: 'run.completed', threadId: 'orch-portfolio' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.dispatch.mock.calls[1][1].prompt).toContain('- a "A"');
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
  });

  it('bounds busy retries and drops the batch with a warning', async () => {
    const t = setup({ threads: { a: { title: 'A' } }, dispatch: async () => { throw busyError(); } });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    await t.fire();
    for (let i = 0; i < 6; i++) {
      t.emit({ kind: 'run.completed', threadId: 'orch-portfolio' });
      await t.settle();
      await t.fire();
    }
    expect(t.dispatch.mock.calls.length).toBeLessThanOrEqual(4);
    expect(t.warn).toHaveBeenCalled();
  });

  it('invalidateBucket discards a queued batch', async () => {
    const t = setup({ threads: { a: { title: 'A' } } });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    t.service.invalidateBucket('portfolio');
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('invalidateBucket discards an in-flight flush and does not revive it when new activity arrives', async () => {
    const releases: Array<() => void> = [];
    const t = setup({ threads: { old: { title: 'Old' }, fresh: { title: 'New' } } });
    const get = t.api.threads.get as ReturnType<typeof vi.fn>;
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (id: string) => {
      if (id === 'old') await new Promise<void>(resolve => releases.push(resolve));
      return original(id);
    });
    // 'old' is resolved to a bucket before the gate is installed? No: bucket resolution also calls get, so
    // release it immediately and only hold the flush-time lookup.
    t.emit({ kind: 'run.completed', threadId: 'old' });
    await t.settle();
    releases.splice(0).forEach(r => r()); // bucket resolution
    await t.settle();
    await t.fire(); // flush starts, blocks on get('old')
    await t.settle();
    t.service.invalidateBucket('portfolio');
    t.emit({ kind: 'run.completed', threadId: 'fresh' });
    await t.settle();
    releases.splice(0).forEach(r => r());
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toContain('fresh');
    expect(t.dispatch.mock.calls[0][1].prompt).not.toContain('"Old"');
  });

  it('stop disposes the subscription, clears timers and ignores later events', async () => {
    const t = setup({ threads: { a: { title: 'A' } } });
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    t.service.stop();
    expect(t.subscriptionDispose).toHaveBeenCalledTimes(1);
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
    t.emit({ kind: 'run.completed', threadId: 'a' });
    await t.settle();
    expect(t.callbacks).toHaveLength(0);
  });
});
