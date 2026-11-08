import { describe, expect, it, vi } from 'vitest';
import { WakeupService } from '../WakeupService';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const err = (code: string) => Object.assign(new Error(code), { code });
const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'orch-portfolio', title: 'Portfolio', enabled: true } as OrchestratorSnapshot;
const p1 = (enabled?: boolean) => ({ id: 'project:p1', kind: 'project', threadId: 'orch-p1', projectId: 'p1', title: 'P1', enabled } as OrchestratorSnapshot);

function setup(o: {
  threads?: Record<string, { title?: string; projectId?: string }>;
  orchestrators?: OrchestratorSnapshot[];
  dispatch?: (target: { id: string }, input: { prompt: string; queueIfBusy?: boolean }) => Promise<{ runId: string }>;
} = {}) {
  let listener!: (e: PublicThreadEvent) => void;
  const threads = o.threads ?? {};
  const state = { orchestrators: o.orchestrators ?? [portfolio] };
  const dispatch = vi.fn(o.dispatch ?? (async () => ({ runId: 'r' })));
  const list = vi.fn(async () => state.orchestrators);
  const get = vi.fn(async (id: string) => threads[id] ? { id, title: threads[id].title ?? '', projectId: threads[id].projectId, updatedAt: 5, messages: [] } : null);
  const api = {
    apiVersion: 1, generation: 'g', capabilities: [],
    threads: { subscribe: vi.fn((fn: typeof listener) => { listener = fn; return { dispose() {} }; }), get },
    orchestrators: { list, dispatch },
  } as unknown as ClaudeThreadsApiV1;
  const callbacks: Array<() => void> = [];
  const cleared: number[] = [];
  const warn = vi.fn(); const error = vi.fn();
  const service = new WakeupService(api, {
    setTimeoutFn: cb => { callbacks.push(cb); return cb; },
    clearTimeoutFn: h => { const i = callbacks.indexOf(h as () => void); if (i >= 0) { callbacks.splice(i, 1); cleared.push(i); } },
    onWarn: warn, onError: error,
  });
  service.start();
  const emit = (kind: 'run.completed' | 'run.failed', threadId: string) =>
    listener({ kind, threadId, runId: 'r', at: 1, error: { code: 'RUN_FAILED', message: 'x' } } as PublicThreadEvent);
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const fire = async () => { callbacks.splice(0).forEach(cb => cb()); await settle(); };
  return { service, emit, settle, fire, callbacks, cleared, dispatch, list, get, state, warn, error, api };
}
const prompts = (t: ReturnType<typeof setup>) => t.dispatch.mock.calls.map(c => `${c[0].id}:${c[1].prompt}`);

describe('WakeupService QA: no self-ping loop', () => {
  it('a wake-up to the portfolio orchestrator whose own run.completed follows schedules nothing', async () => {
    const t = setup({ threads: { w: { title: 'W' }, 'orch-portfolio': { title: 'O' } } });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    t.emit('run.completed', 'orch-portfolio'); await t.settle();
    expect(t.callbacks).toHaveLength(0);
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a failed (run.failed) portfolio orchestrator run does not wake itself either', async () => {
    const t = setup({ threads: { 'orch-portfolio': {} } });
    t.emit('run.failed', 'orch-portfolio'); await t.settle(); await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('chain worker -> project orchestrator -> portfolio terminates: portfolio completion adds nothing', async () => {
    const t = setup({
      threads: { w: { title: 'W', projectId: 'p1' }, 'orch-p1': { title: 'PO', projectId: 'p1' }, 'orch-portfolio': {} },
      orchestrators: [portfolio, p1(true)],
    });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    t.emit('run.completed', 'orch-p1'); await t.settle(); await t.fire();
    t.emit('run.completed', 'orch-portfolio'); await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1', 'portfolio']);
  });

  it('a Project orchestrator of a DISABLED project still routes to the portfolio, not dropped', async () => {
    const t = setup({ threads: { 'orch-p1': { title: 'PO', projectId: 'p1' } }, orchestrators: [portfolio, p1(false)] });
    t.emit('run.completed', 'orch-p1'); await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['portfolio']);
  });

  it('a Project thread whose orchestrator does not exist yet routes to project:<id> (lazily created by core)', async () => {
    const t = setup({ threads: { w: { title: 'W', projectId: 'new' } } });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls[0][0]).toEqual({ id: 'project:new' });
  });
});

describe('WakeupService QA: debounce and batching', () => {
  it('a second event re-arms (clears) the debounce timer so only one dispatch results', async () => {
    const t = setup({ threads: { a: { title: 'A' }, b: { title: 'B' } } });
    t.emit('run.completed', 'a'); await t.settle();
    t.emit('run.completed', 'b'); await t.settle();
    expect(t.callbacks).toHaveLength(1);
    expect(t.cleared.length).toBe(1);
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toMatch(/^New activity on 2 threads\. Review only the named changed threads;/);
  });

  it('pluralises for 3 threads and sends queueIfBusy:true', async () => {
    const t = setup({ threads: { a: {}, b: {}, c: {} } });
    for (const id of ['a', 'b', 'c']) t.emit('run.completed', id);
    await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls[0][1].prompt.split('\n')[0]).toBe('New activity on 3 threads. Review only the named changed threads; do not run a full reconciliation. The heartbeat handles missed activity.');
    expect(t.dispatch.mock.calls[0][1].queueIfBusy).toBe(true);
  });

  it('a get() rejection while composing falls back to bare id / unavailable', async () => {
    const t = setup({ threads: { a: { title: 'A' } } });
    t.emit('run.completed', 'a'); await t.settle();
    t.get.mockRejectedValue(new Error('gone'));
    await t.fire();
    expect(t.dispatch.mock.calls[0][1].prompt).toBe('New activity on 1 thread. Review only the named changed thread; do not run a full reconciliation. The heartbeat handles missed activity.\n- a (done; updatedAt=unavailable)');
  });

  it('an event during an in-flight flush starts a new batch that is delivered separately', async () => {
    const t = setup({ threads: { a: { title: 'A' }, b: { title: 'B' } } });
    t.emit('run.completed', 'a'); await t.settle(); await t.fire();
    t.emit('run.completed', 'b'); await t.settle(); await t.fire();
    expect(prompts(t)).toHaveLength(2);
    expect(prompts(t)[0]).not.toContain('"B"');
    expect(prompts(t)[1]).not.toContain('"A"');
  });
});

describe('WakeupService QA: failure handling', () => {
  it('orchestrators.list() rejecting is reported via onError and schedules nothing', async () => {
    const t = setup({ threads: { a: {} } });
    t.list.mockRejectedValue(new Error('api down'));
    t.emit('run.completed', 'a'); await t.settle();
    expect(t.error).toHaveBeenCalledTimes(1);
    expect(t.callbacks).toHaveLength(0);
  });

  it('threads.get() rejecting during bucket resolution is reported via onError and schedules nothing', async () => {
    const t = setup({ threads: { a: {} } });
    t.get.mockRejectedValue(new Error('boom'));
    t.emit('run.completed', 'a'); await t.settle();
    expect(t.error).toHaveBeenCalledTimes(1);
    expect(t.callbacks).toHaveLength(0);
  });

  it('retries exactly maxBusyRetries (3) times then drops with one warning', async () => {
    const t = setup({ threads: { a: { title: 'A' } }, dispatch: async () => { throw err('THREAD_BUSY'); } });
    t.emit('run.completed', 'a'); await t.settle(); await t.fire();
    for (let i = 0; i < 8; i++) { t.emit('run.completed', 'orch-portfolio'); await t.settle(); await t.fire(); }
    expect(t.dispatch).toHaveBeenCalledTimes(4);
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(t.error).not.toHaveBeenCalled();
  });

  it('THREAD_BUSY on a Project bucket never falls back to a summary-only portfolio ping', async () => {
    const t = setup({
      threads: { w: { title: 'W', projectId: 'p1' } }, orchestrators: [portfolio, p1(true)],
      dispatch: async () => { throw err('THREAD_BUSY'); },
    });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).toEqual(['project:p1']);
  });

  it('a held batch merges with newer activity and the newer status wins', async () => {
    let busy = true;
    const t = setup({ threads: { a: { title: 'A' }, b: { title: 'B' } }, dispatch: async () => { if (busy) throw err('THREAD_BUSY'); return { runId: 'r' }; } });
    t.emit('run.failed', 'a'); await t.settle(); await t.fire();
    busy = false;
    t.emit('run.completed', 'a'); t.emit('run.completed', 'b'); await t.settle();
    t.emit('run.completed', 'orch-portfolio'); await t.settle(); await t.fire();
    const last = t.dispatch.mock.calls.at(-1)![1].prompt;
    expect(last).toContain('New activity on 2 threads');
    expect(last).toContain('- a "A" (done;');
    expect(last).not.toContain('(error;');
  });

  it('a non-busy error on the portfolio dispatch goes to onError only (no second dispatch)', async () => {
    const t = setup({ threads: { a: {} }, dispatch: async () => { throw err('PLUGIN_UNAVAILABLE'); } });
    t.emit('run.completed', 'a'); await t.settle(); await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it('when both the Project dispatch and the summary-only dispatch fail, onError is called once and nothing throws', async () => {
    const t = setup({ threads: { w: { projectId: 'p1' } }, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw err('PLUGIN_UNAVAILABLE'); } });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION PROBE: a Project disabled during the debounce window must not leak a summary-only portfolio ping (core drops it silently)', async () => {
    const t = setup({
      threads: { w: { title: 'Secret', projectId: 'p1' } }, orchestrators: [portfolio, p1(true)],
      dispatch: async target => { if (target.id === 'project:p1') throw err('ORCHESTRATOR_NOT_FOUND'); return { runId: 'r' }; },
    });
    t.emit('run.completed', 'w'); await t.settle();
    t.state.orchestrators = [portfolio, p1(false)]; // user disables the Project orchestrator before the flush
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => c[0].id)).not.toContain('portfolio');
  });
});

describe('WakeupService QA: stop() inertness', () => {
  it('stop() while orchestrators.list() is in flight arms no timer', async () => {
    const t = setup({ threads: { a: {} } });
    let release!: () => void;
    t.list.mockImplementation(() => new Promise(r => { release = () => r([portfolio]); }));
    t.emit('run.completed', 'a'); await t.settle();
    t.service.stop();
    release(); await t.settle();
    expect(t.callbacks).toHaveLength(0);
  });

  it('stop() while a flush is composing its message sends nothing', async () => {
    const t = setup({ threads: { a: { title: 'A' } } });
    t.emit('run.completed', 'a'); await t.settle();
    let release!: () => void;
    t.get.mockImplementation(() => new Promise(r => { release = () => r(null); }));
    await t.fire();
    t.service.stop();
    release(); await t.settle();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('stop() while a THREAD_BUSY rejection is pending does not hold the batch for retry', async () => {
    let reject!: (e: Error) => void;
    const t = setup({ threads: { a: {} }, dispatch: () => new Promise((_, rej) => { reject = rej; }) });
    t.emit('run.completed', 'a'); await t.settle(); await t.fire();
    t.service.stop();
    reject(err('THREAD_BUSY')); await t.settle();
    t.service.start();
    t.emit('run.completed', 'orch-portfolio'); await t.settle(); await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stop() then start() resumes normal operation with a fresh state', async () => {
    const t = setup({ threads: { a: { title: 'A' }, b: { title: 'B' } } });
    t.emit('run.completed', 'a'); await t.settle();
    t.service.stop(); t.service.start();
    t.emit('run.completed', 'b'); await t.settle(); await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1].prompt).toContain('"B"');
    expect(t.dispatch.mock.calls[0][1].prompt).not.toContain('"A"');
  });

  it('start() twice subscribes once', () => {
    const t = setup();
    t.service.start();
    expect((t.api.threads.subscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

describe('WakeupService QA: Project state re-check at flush (fix 71cdfb8)', () => {
  const proj = { threads: { w: { title: 'Secret', projectId: 'p1' } } };
  const ids = (t: ReturnType<typeof setup>) => t.dispatch.mock.calls.map(c => c[0].id);

  it('a Project already disabled when the flush starts gets no dispatch at all', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)] });
    t.emit('run.completed', 'w'); await t.settle();
    t.state.orchestrators = [portfolio, p1(false)];
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('a Project missing from the list at flush start is still dispatched to (core may create it lazily)', async () => {
    const t = setup({ ...proj });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('a Project gone from the list after a failed dispatch gets the summary-only ping, like core', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw err('ORCHESTRATOR_NOT_FOUND'); } });
    t.emit('run.completed', 'w'); await t.settle();
    t.state.orchestrators = [portfolio];
    await t.fire();
    expect(ids(t)).toEqual(['project:p1', 'portfolio']);
    expect(t.dispatch.mock.calls[1][1].prompt).toBe('New activity in Project p1 — the Project orchestrator could not be reached.');
  });

  it('race: enabled at the first read, disabled at the second read after a generic dispatch failure -> dropped', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw new Error('creation failed'); } });
    t.emit('run.completed', 'w'); await t.settle();
    let calls = 0;
    t.list.mockImplementation(async () => (++calls <= 1 ? [portfolio, p1(true)] : [portfolio, p1(false)]));
    await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('list() failing at the post-failure re-read sends no summary-only ping and does not throw', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw new Error('unreachable'); } });
    t.emit('run.completed', 'w'); await t.settle();
    let calls = 0;
    t.list.mockImplementation(async () => { if (++calls >= 2) throw new Error('list down'); return [portfolio, p1(true)]; });
    await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('list() failing at flush start does not block the Project dispatch', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)] });
    t.emit('run.completed', 'w'); await t.settle();
    t.list.mockRejectedValue(new Error('list down'));
    await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('stop() while the flush-start list() read is pending dispatches nothing', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)] });
    t.emit('run.completed', 'w'); await t.settle();
    let release!: () => void;
    t.list.mockImplementation(() => new Promise(r => { release = () => r([portfolio, p1(true)]); }));
    await t.fire();
    t.service.stop();
    release(); await t.settle();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('invalidateBucket() while the flush-start list() read is pending dispatches nothing', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)] });
    t.emit('run.completed', 'w'); await t.settle();
    let release!: () => void;
    t.list.mockImplementation(() => new Promise(r => { release = () => r([portfolio, p1(true)]); }));
    await t.fire();
    t.service.invalidateBucket('project:p1');
    release(); await t.settle();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('a Project absent from orchestrators.list() after a failed dispatch gets the summary-only portfolio ping (creation failed / never created)', async () => {
    // Core now lists DISABLED Projects (threadId ''), so absent means enabled-without-thread or creation failed: not a disabled leak.
    const t = setup({ ...proj, dispatch: async target => { if (target.id === 'project:p1') throw new Error('creation failed'); return { runId: 'r' }; } });
    t.emit('run.failed', 'w'); await t.settle(); await t.fire();
    expect(ids(t)).toEqual(['project:p1', 'portfolio']);
    expect(t.dispatch.mock.calls[1][1].prompt).toBe('New activity in Project p1 — the Project orchestrator could not be reached.');
    expect(JSON.stringify(t.dispatch.mock.calls[1])).not.toContain('Secret');
  });

  const disabledNoThread = { id: 'project:p1', kind: 'project', threadId: '', projectId: 'p1', title: 'P1 orchestrator', enabled: false } as OrchestratorSnapshot;

  it('a listed enabled:false thread-less entry at flush start drops the batch with no dispatch at all', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)] });
    t.emit('run.failed', 'w'); await t.settle();
    t.state.orchestrators = [portfolio, disabledNoThread];
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('enabled at flush start, dispatch fails, fresh re-read shows the thread-less enabled:false entry -> one attempt, no portfolio ping', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({
      ...proj, orchestrators: [portfolio, p1(true)],
      dispatch: async target => {
        if (target.id === 'project:p1') { t.state.orchestrators = [portfolio, disabledNoThread]; throw err('ORCHESTRATOR_NOT_FOUND'); }
        return { runId: 'r' };
      },
    });
    t.emit('run.failed', 'w'); await t.settle(); await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('a failed orchestrators.list() read after a failed dispatch drops the batch (no ping)', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)], dispatch: async target => { if (target.id === 'project:p1') throw new Error('x'); return { runId: 'r' }; } });
    t.emit('run.failed', 'w'); await t.settle();
    let calls = 0;
    const original = t.list.getMockImplementation()!;
    t.list.mockImplementation(async () => { if (++calls >= 2) throw new Error('list down'); return original(); });
    await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('stop() is inert (and reports, not throws) even when the subscription dispose() throws', async () => {
    let listener!: (e: PublicThreadEvent) => void;
    const api = {
      apiVersion: 1, generation: 'g', capabilities: [],
      threads: { subscribe: vi.fn((fn: typeof listener) => { listener = fn; return { dispose() { throw new Error('dispose failed'); } }; }), get: vi.fn(async () => ({ id: 'a', title: 'A', updatedAt: 1, messages: [] })) },
      orchestrators: { list: vi.fn(async () => [portfolio]), dispatch: vi.fn() },
    } as unknown as ClaudeThreadsApiV1;
    const callbacks: Array<() => void> = []; const onError = vi.fn();
    const service = new WakeupService(api, { setTimeoutFn: cb => { callbacks.push(cb); return cb; }, clearTimeoutFn: () => {}, onError });
    service.start();
    expect(() => service.stop()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    listener({ kind: 'run.completed', threadId: 'a', runId: 'r', at: 1 } as PublicThreadEvent);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(callbacks).toHaveLength(0);
  });

  it('summary-only never contains Project thread details even when sent after the re-check', async () => {
    const t = setup({ ...proj, orchestrators: [portfolio, p1(true)], dispatch: async target => { if (target.id === 'project:p1') throw new Error('x'); return { runId: 'r' }; } });
    t.emit('run.failed', 'w'); await t.settle(); await t.fire();
    expect(t.dispatch.mock.calls[1][1].prompt).toBe('New activity in Project p1 — the Project orchestrator could not be reached.');
  });
});

describe('WakeupService QA round 2: thread-less disabled entries and summary-only edge cases', () => {
  const dnt = { id: 'project:p1', kind: 'project', threadId: '', projectId: 'p1', title: 'P1 orchestrator', enabled: false } as OrchestratorSnapshot;
  const ids = (t: ReturnType<typeof setup>) => t.dispatch.mock.calls.map(c => c[0].id);

  it('a listed thread-less disabled entry (threadId "") does not capture unrelated events as an orchestrator thread', async () => {
    const t = setup({ threads: { a: { title: 'A' } }, orchestrators: [portfolio, dnt] });
    t.emit('run.completed', 'a'); await t.settle(); await t.fire();
    expect(ids(t)).toEqual(['portfolio']);
  });

  it('a worker in a Project listed only as a thread-less disabled entry is dropped at event time (nothing scheduled)', async () => {
    const t = setup({ threads: { w: { title: 'W', projectId: 'p1' } }, orchestrators: [portfolio, dnt] });
    t.emit('run.completed', 'w'); await t.settle();
    expect(t.callbacks).toHaveLength(0);
    await t.fire();
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('a list failure after a failed dispatch warns (once) and drops, without calling onError', async () => {
    const t = setup({ threads: { w: { projectId: 'p1' } }, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw new Error('x'); } });
    t.emit('run.completed', 'w'); await t.settle();
    let n = 0; t.list.mockImplementation(async () => { if (++n >= 2) throw new Error('down'); return [portfolio, p1(true)]; });
    await t.fire();
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(t.warn.mock.calls[0][0]).toContain('project:p1');
    expect(ids(t)).toEqual(['project:p1']);
  });

  it('summary-only goes to the portfolio exactly once per failed batch and a failing summary dispatch reports onError once', async () => {
    const t = setup({ threads: { w: { projectId: 'p1' } }, orchestrators: [portfolio, p1(true)], dispatch: async () => { throw new Error('all down'); } });
    t.emit('run.completed', 'w'); await t.settle(); await t.fire();
    await t.fire();
    expect(ids(t)).toEqual(['project:p1', 'portfolio']);
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it('two Projects failing in one window each produce their own summary-only ping naming only their own id', async () => {
    const q = { id: 'project:p2', kind: 'project', threadId: 'orch-p2', projectId: 'p2', title: 'P2', enabled: true } as OrchestratorSnapshot;
    const t = setup({
      threads: { w1: { title: 'S1', projectId: 'p1' }, w2: { title: 'S2', projectId: 'p2' } }, orchestrators: [portfolio, p1(true), q],
      dispatch: async target => { if (target.id.startsWith('project:')) throw new Error('x'); return { runId: 'r' }; },
    });
    t.emit('run.completed', 'w1'); t.emit('run.completed', 'w2'); await t.settle(); await t.fire();
    const summaries = t.dispatch.mock.calls.filter(c => c[0].id === 'portfolio').map(c => c[1].prompt).sort();
    expect(summaries).toEqual([
      'New activity in Project p1 — the Project orchestrator could not be reached.',
      'New activity in Project p2 — the Project orchestrator could not be reached.',
    ]);
  });

  it('invalidateBucket between the failed dispatch and the summary-only send suppresses the ping', async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({
      threads: { w: { projectId: 'p1' } }, orchestrators: [portfolio, p1(true)],
      dispatch: async target => { if (target.id === 'project:p1') { setTimeout(() => {}, 0); throw new Error('x'); } return { runId: 'r' }; },
    });
    t.emit('run.completed', 'w'); await t.settle();
    let n = 0; const orig = t.list.getMockImplementation()!;
    t.list.mockImplementation(async () => { if (++n === 2) t.service.invalidateBucket('project:p1'); return orig(); });
    await t.fire();
    expect(ids(t)).toEqual(['project:p1']);
  });
});
