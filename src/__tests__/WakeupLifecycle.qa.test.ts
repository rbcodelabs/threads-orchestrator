import { describe, expect, it, vi } from 'vitest';
import { WakeupLifecycle, type WakeupServiceLike } from '../WakeupLifecycle';
import type { ClaudeThreadsApiV1, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const CAP = 'orchestrators.wakeup.delegate';
function makeApi(generation: string, log: string[], caps: string[] = [CAP], withFn = true) {
  const listeners: Array<(e: PublicThreadEvent) => void> = [];
  const dispatch = vi.fn(async () => ({ runId: 'r' }));
  const api = {
    apiVersion: 1, generation, capabilities: caps,
    threads: {
      subscribe: vi.fn((fn: (e: PublicThreadEvent) => void) => { listeners.push(fn); return { dispose: () => { log.push(`unsub:${generation}`); } }; }),
      get: vi.fn(async (id: string) => ({ id, title: 'T', updatedAt: 1, messages: [] })),
    },
    orchestrators: {
      list: vi.fn(async () => [{ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'P', enabled: true }]), dispatch,
      ...(withFn ? { delegateWakeup: vi.fn(() => { log.push(`claim:${generation}`); return { dispose: () => { log.push(`release:${generation}`); } }; }) } : {}),
    },
  } as unknown as ClaudeThreadsApiV1;
  const emit = (threadId: string) => listeners.forEach(l => l({ kind: 'run.completed', threadId, runId: 'r', at: 1 } as PublicThreadEvent));
  return { api, dispatch, emit, listeners };
}
function makeClient(initial: ClaudeThreadsApiV1 | null) {
  let current = initial; const ls = new Set<(a: ClaudeThreadsApiV1 | null) => void>();
  return { current: () => current, onChange: (l: (a: ClaudeThreadsApiV1 | null) => void) => { ls.add(l); return () => { ls.delete(l); }; }, set: (a: ClaudeThreadsApiV1 | null) => { current = a; ls.forEach(l => l(a)); } };
}

describe('WakeupLifecycle QA', () => {
  it('re-claims on a direct api1 -> api2 swap (no null in between): old released before new claimed', () => {
    const log: string[] = [];
    const a1 = makeApi('g1', log), a2 = makeApi('g2', log);
    const client = makeClient(a1.api);
    const lc = new WakeupLifecycle({ client, pluginId: 'p', isEnabled: () => true });
    lc.start();
    client.set(a2.api);
    expect(log.filter(l => !l.startsWith('unsub'))).toEqual(['claim:g1', 'release:g1', 'claim:g2']);
    expect(log.indexOf('release:g1')).toBeLessThan(log.indexOf('claim:g2'));
  });

  it('the old generation service is inert after the swap even if its stale listener still fires', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const a1 = makeApi('g1', log), a2 = makeApi('g2', log);
      const client = makeClient(a1.api);
      const lc = new WakeupLifecycle({ client, pluginId: 'p', isEnabled: () => true });
      lc.start(); client.set(a2.api);
      a1.emit('t1');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a1.dispatch).not.toHaveBeenCalled();
      a2.emit('t1');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a2.dispatch).toHaveBeenCalledTimes(1);
      lc.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('end to end with the real WakeupService: claim -> one wake-up after the 12 s debounce -> setting off stops it', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const a = makeApi('g1', log);
      const enabled = { v: true };
      const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => enabled.v });
      lc.start();
      a.emit('t1'); a.emit('t2');
      await vi.advanceTimersByTimeAsync(11_999);
      expect(a.dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(a.dispatch).toHaveBeenCalledTimes(1);
      enabled.v = false; lc.sync();
      expect(log).toContain('release:g1');
      a.emit('t3');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a.dispatch).toHaveBeenCalledTimes(1);
      lc.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('a batch queued when the setting is turned off is never delivered', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const a = makeApi('g1', log);
      const enabled = { v: true };
      const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => enabled.v });
      lc.start(); a.emit('t1');
      await vi.advanceTimersByTimeAsync(5_000);
      enabled.v = false; lc.sync();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.dispatch).not.toHaveBeenCalled();
      lc.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('dispose while a batch is queued never delivers it', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const a = makeApi('g1', log);
      const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true });
      lc.start(); a.emit('t1');
      await vi.advanceTimersByTimeAsync(1_000);
      lc.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.dispatch).not.toHaveBeenCalled();
      expect(log).toContain('release:g1');
    } finally { vi.useRealTimers(); }
  });

  it('capability advertised but delegateWakeup missing -> no claim, no service', () => {
    const log: string[] = [];
    const a = makeApi('g1', log, [CAP], false);
    const create = vi.fn();
    new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true, createService: create }).start();
    expect(create).not.toHaveBeenCalled();
    expect(a.listeners).toHaveLength(0);
  });

  it('capability absent -> the real service never subscribes (core keeps pinging)', () => {
    const log: string[] = [];
    const a = makeApi('g1', log, [], false);
    new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true }).start();
    expect(a.listeners).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('a failed claim is retried on the next sync and succeeds', () => {
    const log: string[] = [];
    const a = makeApi('g1', log);
    const fn = a.api.orchestrators.delegateWakeup as unknown as ReturnType<typeof vi.fn>;
    const real = fn.getMockImplementation()!;
    fn.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { code: 'PLUGIN_UNAVAILABLE' }); });
    const warn = vi.fn();
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true, onWarn: warn });
    lc.start();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(a.listeners).toHaveLength(0);
    lc.sync();
    expect(a.listeners).toHaveLength(1);
    expect(real).toBeDefined();
  });

  it('rapid toggle off/on/off releases every claim exactly once', () => {
    const log: string[] = [];
    const a = makeApi('g1', log);
    const enabled = { v: true };
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => enabled.v });
    lc.start();
    for (const v of [false, true, false]) { enabled.v = v; lc.sync(); }
    const filtered = log.filter(l => !l.startsWith('unsub'));
    expect(filtered).toEqual(['claim:g1', 'release:g1', 'claim:g1', 'release:g1']);
  });

  it('start() after dispose() and sync() after dispose() are no-ops', () => {
    const log: string[] = [];
    const a = makeApi('g1', log);
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true });
    lc.dispose(); lc.start(); lc.sync();
    expect(log).toEqual([]);
  });

  it('passes the plugin id to delegateWakeup and stops the service before disposing the delegate', () => {
    const order: string[] = [];
    const a = makeApi('g1', []);
    const fn = a.api.orchestrators.delegateWakeup as unknown as ReturnType<typeof vi.fn>;
    fn.mockImplementation(() => ({ dispose: () => order.push('delegate.dispose') }));
    const svc: WakeupServiceLike = { start() {}, stop: () => { order.push('service.stop'); } };
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'threads-orchestrator', isEnabled: () => true, createService: () => svc });
    lc.start(); lc.dispose();
    expect(fn).toHaveBeenCalledWith({ pluginId: 'threads-orchestrator' });
    expect(order).toEqual(['service.stop', 'delegate.dispose']);
  });
});

describe('WakeupLifecycle QA: teardown robustness (a99ed43)', () => {
  it('releases the delegate even when service.stop() throws (a leaked claim keeps core wake-ups suppressed)', () => {
    const a = makeApi('g1', []);
    const dispose = vi.fn();
    (a.api.orchestrators.delegateWakeup as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ dispose }));
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true, createService: () => ({ start() {}, stop() { throw new Error('stop failed'); } }) });
    lc.start();
    try { lc.dispose(); } catch { /* tolerated: the claim must still be released */ }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() twice (onunload then the register() safety net) disposes the delegate exactly once', () => {
    const a = makeApi('g1', []);
    const dispose = vi.fn();
    (a.api.orchestrators.delegateWakeup as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ dispose }));
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true });
    lc.start(); lc.dispose(); lc.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a service whose start() throws releases the claim and a later sync can retry', () => {
    const a = makeApi('g1', []);
    const dispose = vi.fn();
    (a.api.orchestrators.delegateWakeup as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ dispose }));
    let n = 0;
    const lc = new WakeupLifecycle({ client: makeClient(a.api), pluginId: 'p', isEnabled: () => true, onWarn: () => {}, createService: () => ({ start() { if (++n === 1) throw new Error('boom'); }, stop() {} }) });
    lc.start();
    expect(dispose).toHaveBeenCalledTimes(1);
    lc.sync();
    expect(n).toBe(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
