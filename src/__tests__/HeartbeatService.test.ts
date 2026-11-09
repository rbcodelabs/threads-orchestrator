import { describe, expect, it, vi } from 'vitest';
import { HeartbeatService, PORTFOLIO_HEARTBEAT_PROMPT, PROJECT_HEARTBEAT_PROMPT } from '../HeartbeatService';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot } from '../ClaudeThreadsApiTypes';

const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'tp', title: 'Portfolio' } as OrchestratorSnapshot;
const projA = { id: 'project:a', kind: 'project', projectId: 'a', threadId: 'ta', title: 'A', enabled: true } as OrchestratorSnapshot;
const projB = { id: 'project:b', kind: 'project', projectId: 'b', threadId: '', title: 'B', enabled: false } as OrchestratorSnapshot;
const projNoFlag = { id: 'project:c', kind: 'project', projectId: 'c', threadId: 'tc', title: 'C' } as OrchestratorSnapshot;

function setup(list: OrchestratorSnapshot[] | (() => Promise<OrchestratorSnapshot[]>), dispatch?: (t: { id: string }, i: unknown) => Promise<{ runId: string }>, intervalMs = 3_600_000) {
  const dispatchFn = vi.fn(dispatch ?? (async () => ({ runId: 'r' })));
  const api = { orchestrators: { list: vi.fn(typeof list === 'function' ? list : async () => list), dispatch: dispatchFn } } as unknown as ClaudeThreadsApiV1;
  let tick: (() => void) | null = null;
  const cleared: unknown[] = [];
  const intervals: number[] = [];
  const onError = vi.fn(); const onWarn = vi.fn();
  const service = new HeartbeatService(api, {
    intervalMs, onError, onWarn,
    setIntervalFn: (cb, ms) => { tick = cb; intervals.push(ms); return 'handle'; },
    clearIntervalFn: h => { cleared.push(h); tick = null; },
  });
  const fire = async () => { tick?.(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
  return { service, api, dispatch: dispatchFn, fire, cleared, intervals, onError, onWarn, hasTimer: () => tick !== null };
}

describe('HeartbeatService', () => {
  it('copies core heartbeat prompts exactly', () => {
    expect(PORTFOLIO_HEARTBEAT_PROMPT).toBe('Heartbeat: reconcile activity missed by targeted event reviews across all threads. Do not reopen concluded work whose updatedAt is unchanged.');
    expect(PROJECT_HEARTBEAT_PROMPT).toBe('Heartbeat: reconcile Project activity missed by targeted event reviews. Do not reopen concluded work whose updatedAt is unchanged.');
  });

  it('arms one interval timer with the configured period and does not fire immediately', () => {
    const t = setup([portfolio], undefined, 5 * 60_000);
    t.service.start();
    t.service.start();
    expect(t.intervals).toEqual([5 * 60_000]);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('on each tick pings the Portfolio and every enabled Project with queueIfBusy; skips disabled/threadless ones', async () => {
    const t = setup([portfolio, projA, projB, projNoFlag]);
    t.service.start();
    await t.fire();
    expect(t.dispatch.mock.calls).toEqual([
      [{ id: 'portfolio' }, { prompt: PORTFOLIO_HEARTBEAT_PROMPT, queueIfBusy: true }],
      [{ id: 'project:a' }, { prompt: PROJECT_HEARTBEAT_PROMPT, queueIfBusy: true }],
      [{ id: 'project:c' }, { prompt: PROJECT_HEARTBEAT_PROMPT, queueIfBusy: true }],
    ]);
  });

  it('does not create a Portfolio orchestrator that does not exist yet (core parity: no thread, no heartbeat)', async () => {
    const t = setup([projA]);
    t.service.start();
    await t.fire();
    expect(t.dispatch.mock.calls.map(c => (c[0] as { id: string }).id)).toEqual(['project:a']);
  });

  it('one failed dispatch does not stop the others and is reported', async () => {
    const t = setup([portfolio, projA], async target => { if (target.id === 'portfolio') throw new Error('nope'); return { runId: 'r' }; });
    t.service.start();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.onError).toHaveBeenCalledTimes(1);
  });

  it('a failing list is reported and the next tick still runs', async () => {
    let fail = true;
    const t = setup(async () => { if (fail) throw new Error('list failed'); return [portfolio]; });
    t.service.start();
    await t.fire();
    expect(t.onError).toHaveBeenCalledTimes(1);
    fail = false;
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const t = setup([portfolio], async () => { await gate; return { runId: 'r' }; });
    t.service.start();
    await t.fire();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    release();
    await t.fire();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
  });

  it('stop clears the timer and an in-flight tick never dispatches afterwards', async () => {
    let release!: (v: OrchestratorSnapshot[]) => void;
    const t = setup(() => new Promise<OrchestratorSnapshot[]>(r => { release = r; }));
    t.service.start();
    await t.fire();
    t.service.stop();
    expect(t.cleared).toEqual(['handle']);
    release([portfolio, projA]);
    await new Promise(r => setTimeout(r, 0));
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(() => t.service.stop()).not.toThrow();
  });
});
