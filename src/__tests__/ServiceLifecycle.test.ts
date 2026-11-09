import { describe, expect, it, vi } from 'vitest';
import { ServiceLifecycle, type ServiceLike } from '../ServiceLifecycle';
import { WakeupService } from '../WakeupService';
import { REQUIRED_CORE_CAPABILITIES, type ClaudeThreadsApiV1, type PublicThreadEvent } from '../ClaudeThreadsApiTypes';

function makeApi(capabilities: readonly string[] = REQUIRED_CORE_CAPABILITIES, generation = 'g1') {
  const listeners: Array<(e: PublicThreadEvent) => void> = [];
  const unsub = vi.fn();
  const dispatch = vi.fn(async () => ({ runId: 'r' }));
  const api = {
    apiVersion: 1, generation, capabilities,
    threads: {
      subscribe: vi.fn((fn: (e: PublicThreadEvent) => void) => { listeners.push(fn); return { dispose: unsub }; }),
      get: vi.fn(async (id: string) => ({ id, title: 'T', updatedAt: 1, messages: [] })),
    },
    orchestrators: { list: vi.fn(async () => [{ id: 'portfolio', kind: 'portfolio', threadId: 'orch', title: 'P', enabled: true }]), dispatch },
  } as unknown as ClaudeThreadsApiV1;
  const emit = (threadId: string) => listeners.forEach(l => l({ kind: 'run.completed', threadId, runId: 'r', at: 1 } as PublicThreadEvent));
  return { api, dispatch, emit, listeners, unsub };
}

function makeClient(initial: ClaudeThreadsApiV1 | null) {
  let current = initial;
  const listeners = new Set<(api: ClaudeThreadsApiV1 | null) => void>();
  return {
    current: () => current,
    onChange: (l: (api: ClaudeThreadsApiV1 | null) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set: (api: ClaudeThreadsApiV1 | null) => { current = api; listeners.forEach(l => l(api)); },
    listenerCount: () => listeners.size,
  };
}

function setup(client: ReturnType<typeof makeClient>, enabled = { value: true }, extra: { onWarn?: (m: string) => void } = {}) {
  const services: Array<ServiceLike & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const lifecycle = new ServiceLifecycle({
    client, label: 'test service', isEnabled: () => enabled.value, onWarn: extra.onWarn,
    createService: () => { const s = { start: vi.fn(), stop: vi.fn() }; services.push(s); return s; },
  });
  return { lifecycle, services, enabled };
}

describe('ServiceLifecycle', () => {
  it('does nothing when the API is unavailable', () => {
    const { lifecycle, services } = setup(makeClient(null));
    lifecycle.start();
    expect(services).toHaveLength(0);
  });

  it('starts the service when the API has every required core capability and the setting is on', () => {
    const { lifecycle, services } = setup(makeClient(makeApi().api));
    lifecycle.start();
    expect(services).toHaveLength(1);
    expect(services[0].start).toHaveBeenCalledTimes(1);
  });

  it('never starts against a core missing a required capability (no fallback) and warns once per generation', () => {
    const onWarn = vi.fn();
    const old = makeApi(REQUIRED_CORE_CAPABILITIES.slice(1));
    const client = makeClient(old.api);
    const { lifecycle, services } = setup(client, { value: true }, { onWarn });
    lifecycle.start();
    lifecycle.sync();
    expect(services).toHaveLength(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toContain(REQUIRED_CORE_CAPABILITIES[0]);
  });

  it('does not start when the setting is off, and starts when it is turned on', () => {
    const { lifecycle, services, enabled } = setup(makeClient(makeApi().api), { value: false });
    lifecycle.start();
    expect(services).toHaveLength(0);
    enabled.value = true;
    lifecycle.sync();
    expect(services).toHaveLength(1);
  });

  it('stops the service when the setting is turned off', () => {
    const { lifecycle, services, enabled } = setup(makeClient(makeApi().api));
    lifecycle.start();
    enabled.value = false;
    lifecycle.sync();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
  });

  it('sync is idempotent for an unchanged api and setting; restart recreates the service', () => {
    const { lifecycle, services } = setup(makeClient(makeApi().api));
    lifecycle.start();
    lifecycle.sync();
    expect(services).toHaveLength(1);
    lifecycle.restart();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(2);
  });

  it('stops on API stop and restarts on a new generation', () => {
    const client = makeClient(makeApi(undefined, 'g1').api);
    const { lifecycle, services } = setup(client);
    lifecycle.start();
    client.set(null);
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    client.set(makeApi(undefined, 'g2').api);
    expect(services).toHaveLength(2);
  });

  it('a direct generation swap (no null between) stops the old service before starting the new one', () => {
    const order: string[] = [];
    const client = makeClient(makeApi(undefined, 'g1').api);
    const lifecycle = new ServiceLifecycle({
      client, label: 'x', isEnabled: () => true,
      createService: api => ({ start: () => order.push(`start:${api.generation}`), stop: () => order.push(`stop:${api.generation}`) }),
    });
    lifecycle.start();
    client.set(makeApi(undefined, 'g2').api);
    expect(order).toEqual(['start:g1', 'stop:g1', 'start:g2']);
  });

  it('a throwing stop() on the old generation is warned about and the new generation still starts', () => {
    const onWarn = vi.fn();
    const started: string[] = [];
    const client = makeClient(makeApi(undefined, 'g1').api);
    const lifecycle = new ServiceLifecycle({
      client, label: 'x', isEnabled: () => true, onWarn,
      createService: api => ({ start: () => { started.push(api.generation); }, stop: () => { if (api.generation === 'g1') throw new Error('torn down'); } }),
    });
    lifecycle.start();
    expect(() => client.set(makeApi(undefined, 'g2').api)).not.toThrow();
    expect(started).toEqual(['g1', 'g2']);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('torn down'));
  });

  it('lifecycles sharing a warn-once guard log the missing-capability warning once per generation', () => {
    const onWarn = vi.fn();
    const api = makeApi([]).api;
    const shared = { generation: null as string | null };
    for (let i = 0; i < 3; i++) new ServiceLifecycle({ client: makeClient(api), label: 'x' + i, isEnabled: () => true, onWarn, warnOnce: shared, createService: () => ({ start() {}, stop() {} }) }).start();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('dispose stops the service, unsubscribes, and later start/sync/dispose are no-ops', () => {
    const client = makeClient(makeApi().api);
    const { lifecycle, services } = setup(client);
    lifecycle.start();
    lifecycle.dispose();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    expect(client.listenerCount()).toBe(0);
    lifecycle.dispose(); lifecycle.start(); lifecycle.sync();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(1);
  });

  it('a service whose start() throws is not left active; warns; a later sync retries', () => {
    let n = 0;
    const onWarn = vi.fn();
    const stop = vi.fn();
    const lifecycle = new ServiceLifecycle({
      client: makeClient(makeApi().api), label: 'x', isEnabled: () => true, onWarn,
      createService: () => ({ start() { if (++n === 1) throw new Error('boom'); }, stop }),
    });
    lifecycle.start();
    expect(onWarn).toHaveBeenCalledTimes(1);
    lifecycle.sync();
    expect(n).toBe(2);
  });

  it('still disposes (stops the service) when the client unsubscribe throws; second dispose is a no-op', () => {
    const client = makeClient(makeApi().api);
    client.onChange = () => () => { throw new Error('unsubscribe failed'); };
    const stop = vi.fn();
    const lifecycle = new ServiceLifecycle({ client, label: 'x', isEnabled: () => true, createService: () => ({ start() {}, stop }) });
    lifecycle.start();
    try { lifecycle.dispose(); } catch { /* may propagate */ }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.dispose()).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('ServiceLifecycle with the real WakeupService', () => {
  const create = (api: ClaudeThreadsApiV1) => new WakeupService(api);

  it('subscribes and sends one wake-up after the debounce; setting off stops it', async () => {
    vi.useFakeTimers();
    try {
      const a = makeApi();
      const enabled = { v: true };
      const lc = new ServiceLifecycle({ client: makeClient(a.api), label: 'w', isEnabled: () => enabled.v, createService: create });
      lc.start();
      a.emit('t1'); a.emit('t2');
      await vi.advanceTimersByTimeAsync(11_999);
      expect(a.dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(a.dispatch).toHaveBeenCalledTimes(1);
      enabled.v = false; lc.sync();
      expect(a.unsub).toHaveBeenCalledTimes(1);
      a.emit('t3');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a.dispatch).toHaveBeenCalledTimes(1);
      lc.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('a stale generation listener is inert after a swap; dispose while queued never delivers', async () => {
    vi.useFakeTimers();
    try {
      const a1 = makeApi(undefined, 'g1'); const a2 = makeApi(undefined, 'g2');
      const client = makeClient(a1.api);
      const lc = new ServiceLifecycle({ client, label: 'w', isEnabled: () => true, createService: create });
      lc.start(); client.set(a2.api);
      a1.emit('t1');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(a1.dispatch).not.toHaveBeenCalled();
      a2.emit('t1');
      await vi.advanceTimersByTimeAsync(1_000);
      lc.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a2.dispatch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a requested-capability-less core never subscribes', () => {
    const a = makeApi([]);
    new ServiceLifecycle({ client: makeClient(a.api), label: 'w', isEnabled: () => true, createService: create }).start();
    expect(a.listeners).toHaveLength(0);
  });
});
