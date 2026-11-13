import { describe, expect, it, vi } from 'vitest';
import { WakeupService } from '../WakeupService';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const HEADER_1 = 'New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.';
const HEADER_2 = 'New activity on 2 threads. Review only the named changed threads; do not run a full reconciliation. The heartbeat handles missed activity.';

interface ThreadFixture { title?: string; projectId?: string; updatedAt?: number }

function busyError() { return Object.assign(new Error('busy'), { code: 'THREAD_BUSY' }); }
const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'orch-portfolio', title: 'Portfolio' } as OrchestratorSnapshot;

function setup(options: {
  threads?: Record<string, ThreadFixture>;
  orchestrators?: OrchestratorSnapshot[];
  dispatch?: (target: { id: string }, input: { prompt: string; queueIfBusy?: boolean }) => Promise<{ runId: string }>;
  debounceMs?: number;
  threadDebounceMs?: number;
} = {}) {
  let listener!: (event: PublicThreadEvent) => void;
  const threads = options.threads ?? {};
  const orchestrators = { current: options.orchestrators ?? [portfolio] };
  const dispatch = vi.fn(options.dispatch ?? (async () => ({ runId: 'r' })));
  const subscriptionDispose = vi.fn();
  const api = {
    apiVersion: 1, generation: 'g', capabilities: ['orchestrators.ensure'],
    threads: {
      subscribe: vi.fn((fn: typeof listener) => { listener = fn; return { dispose: subscriptionDispose }; }),
      get: vi.fn(async (id: string) => threads[id] ? { id, title: threads[id].title ?? '', projectId: threads[id].projectId, updatedAt: threads[id].updatedAt ?? 1_700_000_000_000, messages: [] } : null),
    },
    orchestrators: { list: vi.fn(async () => orchestrators.current), dispatch },
  } as unknown as ClaudeThreadsApiV1;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const msOf = new Map<() => void, number>();
  const warn = vi.fn();
  const error = vi.fn();
  const service = new WakeupService(api, {
    debounceMs: options.debounceMs,
    threadDebounceMs: options.threadDebounceMs,
    setTimeoutFn: (cb, ms) => { callbacks.push(cb); delays.push(ms); msOf.set(cb, ms); return cb; },
    clearTimeoutFn: handle => { const i = callbacks.indexOf(handle as () => void); if (i >= 0) callbacks.splice(i, 1); },
    onWarn: warn, onError: error,
  });
  service.start();
  const emit = (event: { kind: PublicThreadEvent['kind']; threadId: string }) =>
    listener({ runId: 'r1', at: 1, error: { code: 'RUN_FAILED', message: 'boom' }, ...event } as PublicThreadEvent);
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  // Fires every pending timer, including the follow-up bucket timer a per-thread timer arms (thread debounce -> bucket batch).
  const fire = async () => {
    for (let round = 0; round < 3 && callbacks.length > 0; round++) {
      const pending = callbacks.splice(0);
      pending.forEach(cb => cb());
      await settle();
    }
  };
  // Fires only the pending timers armed with this delay (60000 = per-thread debounce, 12000 = bucket batch).
  const fireWhere = async (ms: number) => {
    const due = callbacks.filter(cb => msOf.get(cb) === ms);
    for (const cb of due) callbacks.splice(callbacks.indexOf(cb), 1);
    due.forEach(cb => cb());
    await settle();
  };
  return { api, service, emit, settle, fire, fireWhere, callbacks, delays, dispatch, warn, error, orchestrators, subscriptionDispose };
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
    await t.fireWhere(60_000); // thread-1 settles and joins the batch the error already opened
    await t.fireWhere(12_000);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toBe([
      HEADER_2,
      '- thread-2 "Update docs" (error; updatedAt=1700000000000)',
      '- thread-1 "Fix login bug" (done; updatedAt=1700000000000)',
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
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    t.emit({ kind: 'run.failed', threadId: 'thread-1' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toBe(`${HEADER_1}\n- thread-1 "Flaky" (error; updatedAt=1700000000000)`);
  });

  it('an error is reported at once and a later done for the same thread is reported separately after its debounce', async () => {
    const t = setup({ threads: { 'thread-1': { title: 'Flaky' } } });
    t.emit({ kind: 'run.failed', threadId: 'thread-1' });
    t.emit({ kind: 'run.completed', threadId: 'thread-1' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[1].prompt.split('\n')[1])).toEqual([
      '- thread-1 "Flaky" (error; updatedAt=1700000000000)',
      '- thread-1 "Flaky" (done; updatedAt=1700000000000)',
    ]);
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
    await def.fireWhere(60_000);
    expect(def.delays).toEqual([60_000, 12_000]);
    const custom = setup({ threads: { a: {} }, debounceMs: 500, threadDebounceMs: 7 });
    custom.emit({ kind: 'run.completed', threadId: 'a' });
    await custom.settle();
    await custom.fireWhere(7);
    expect(custom.delays).toEqual([7, 500]);
  });

  it('does not wake for the portfolio orchestrator thread itself', async () => {
    const t = setup({ threads: { 'orch-portfolio': { title: 'Orchestrator' } } });
    t.emit({ kind: 'run.completed', threadId: 'orch-portfolio' });
    await t.settle();
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('routes Project threads to project:<id> and drops a Project orchestrator thread entirely', async () => {
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
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1']);
    expect(t.dispatch.mock.calls[0][1].prompt).toContain('- w "Worker"');
    expect(t.dispatch.mock.calls[0][1].prompt).not.toContain('orch-p1');
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

  it('falls back to a summary-only portfolio dispatch when an enabled Project orchestrator cannot be reached', async () => {
    const t = setup({
      threads: { w: { title: 'Sensitive task', projectId: 'p1' } },
      orchestrators: [portfolio, { id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled: true } as OrchestratorSnapshot],
      dispatch: async target => { if (target.id === 'project:p1') throw new Error('creation failed'); return { runId: 'r' }; },
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

  it('a Project absent from list() after a failed dispatch gets the summary-only portfolio ping', async () => {
    const t = setup({
      threads: { w: { title: 'Task', projectId: 'p1' } },
      dispatch: async target => { if (target.id === 'project:p1') throw new Error('creation failed'); return { runId: 'r' }; },
    });
    t.emit({ kind: 'run.completed', threadId: 'w' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1', 'portfolio']);
    expect(t.dispatch.mock.calls[1][1].prompt).toBe('New activity in Project p1 — the Project orchestrator could not be reached.');
  });

  it('the summary-only fallback also skips a Portfolio orchestrator that does not exist', async () => {
    const t = setup({
      orchestrators: [],
      threads: { w: { title: 'Task', projectId: 'p1' } },
      dispatch: async target => { if (target.id === 'project:p1') throw new Error('creation failed'); return { runId: 'r' }; },
    });
    t.emit({ kind: 'run.completed', threadId: 'w' });
    await t.settle();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1']);
  });

  it('a portfolio entry without a thread counts as not existing; with a thread the wake-up is sent', async () => {
    const none = setup({ orchestrators: [{ ...portfolio, threadId: '' }], threads: { a: { title: 'A' } } });
    none.emit({ kind: 'run.completed', threadId: 'a' });
    await none.settle(); await none.fire();
    expect(none.dispatch).not.toHaveBeenCalled();
    const some = setup({ threads: { a: { title: 'A' } } });
    some.emit({ kind: 'run.completed', threadId: 'a' });
    await some.settle(); await some.fire();
    expect(some.dispatch).toHaveBeenCalledTimes(1);
  });

  describe('per-thread debounce and project orchestrator filtering', () => {
    const p1Orch = { id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled: true } as OrchestratorSnapshot;

    it("a project orchestrator's own done and error never reach the portfolio", async () => {
      const t = setup({ threads: { 'orch-p1': { title: 'P1 orch', projectId: 'p1' } }, orchestrators: [portfolio, p1Orch] });
      t.emit({ kind: 'run.completed', threadId: 'orch-p1' });
      t.emit({ kind: 'run.failed', threadId: 'orch-p1' });
      await t.settle();
      expect(t.callbacks).toHaveLength(0);
      await t.fire();
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it('three completions of one thread inside the window give one notice with the latest state', async () => {
      const threads = { a: { title: 'Rolling', updatedAt: 1 } };
      const t = setup({ threads });
      for (const updatedAt of [1, 2, 3]) {
        threads.a.updatedAt = updatedAt;
        t.emit({ kind: 'run.completed', threadId: 'a' });
        await t.settle();
        await t.fireWhere(12_000); // 12 s of quiet passes between turns; the 60 s thread window does not
      }
      expect(t.dispatch).not.toHaveBeenCalled();
      expect(t.callbacks).toHaveLength(1);
      await t.fireWhere(60_000);
      expect(t.dispatch).not.toHaveBeenCalled();
      await t.fireWhere(12_000);
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(t.dispatch.mock.calls[0][1].prompt).toBe(`${HEADER_1}\n- a "Rolling" (done; updatedAt=3)`);
    });

    it('each new completion resets the per-thread timer', async () => {
      const t = setup({ threads: { a: {} } });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      const first = t.callbacks[0];
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      expect(t.callbacks).toHaveLength(1);
      expect(t.callbacks[0]).not.toBe(first);
      expect(t.delays).toEqual([60_000, 60_000]);
      first(); // a stale fire of the cancelled timer must not flush anything
      await t.settle();
      expect(t.delays).toEqual([60_000, 60_000]);
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it('an error bypasses the thread debounce and cancels the pending done timer', async () => {
      const t = setup({ threads: { a: { title: 'Flaky' } } });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      t.emit({ kind: 'run.failed', threadId: 'a' });
      await t.settle();
      expect(t.delays).toEqual([60_000, 12_000]); // error goes straight to the 12 s bucket batch
      expect(t.callbacks.map(cb => cb)).toHaveLength(1); // the done timer is gone
      await t.fire();
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(t.dispatch.mock.calls[0][1].prompt).toBe(`${HEADER_1}\n- a "Flaky" (error; updatedAt=1700000000000)`);
    });

    it('a done after an error debounces normally', async () => {
      const t = setup({ threads: { a: { title: 'Flaky' } } });
      t.emit({ kind: 'run.failed', threadId: 'a' });
      await t.settle();
      await t.fire();
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      expect(t.delays.slice(-1)).toEqual([60_000]);
      await t.fire();
      expect(t.dispatch).toHaveBeenCalledTimes(2);
      expect(t.dispatch.mock.calls[1][1].prompt).toContain('(done;');
    });

    it('invalidateBucket clears thread timers and a late fire sends nothing', async () => {
      const t = setup({ threads: { a: { title: 'A' } } });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      const [threadTimer] = t.callbacks;
      expect(t.delays).toEqual([60_000]);
      t.service.invalidateBucket('portfolio');
      expect(t.callbacks).toHaveLength(0);
      threadTimer();
      await t.settle();
      await t.fire();
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it('invalidateBucket leaves thread timers of other buckets alone', async () => {
      const t = setup({ threads: { a: { title: 'A' }, w: { title: 'W', projectId: 'p1' } }, orchestrators: [portfolio, p1Orch] });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      t.emit({ kind: 'run.completed', threadId: 'w' });
      await t.settle();
      expect(t.delays).toEqual([60_000, 60_000]);
      t.service.invalidateBucket('portfolio');
      expect(t.callbacks).toHaveLength(1);
      await t.fire();
      expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1']);
    });

    it('stop clears thread timers and nothing fires afterwards', async () => {
      const t = setup({ threads: { a: { title: 'A' } } });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      const [threadTimer] = t.callbacks;
      expect(t.delays).toEqual([60_000]);
      t.service.stop();
      expect(t.callbacks).toHaveLength(0);
      threadTimer();
      await t.settle();
      await t.fire();
      expect(t.dispatch).not.toHaveBeenCalled();
    });

    it('a thread with no project still notifies the portfolio 60 s after it settles, then batches 12 s', async () => {
      const t = setup({ threads: { a: { title: 'A' } } });
      t.emit({ kind: 'run.completed', threadId: 'a' });
      await t.settle();
      expect(t.delays).toEqual([60_000]);
      await t.fireWhere(60_000);
      expect(t.delays).toEqual([60_000, 12_000]);
      expect(t.dispatch).not.toHaveBeenCalled();
      await t.fireWhere(12_000);
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(t.dispatch.mock.calls[0][0]).toEqual({ id: 'portfolio' });
    });

    it('a Project worker thread is debounced too before it reaches project:<id>', async () => {
      const t = setup({ threads: { w: { title: 'W', projectId: 'p1' } }, orchestrators: [portfolio, p1Orch] });
      t.emit({ kind: 'run.completed', threadId: 'w' });
      t.emit({ kind: 'run.completed', threadId: 'w' });
      await t.settle();
      expect(t.callbacks).toHaveLength(1);
      await t.fire();
      expect(t.dispatch).toHaveBeenCalledTimes(1);
      expect(t.dispatch.mock.calls[0][0]).toEqual({ id: 'project:p1' });
    });
  });
});
