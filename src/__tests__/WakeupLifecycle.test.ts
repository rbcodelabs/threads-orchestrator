import { describe, expect, it, vi } from 'vitest';
import { WakeupLifecycle, type WakeupServiceLike } from '../WakeupLifecycle';
import type { ClaudeThreadsApiV1 } from '../ClaudeThreadsApiTypes';

function makeApi(capabilities: string[], generation = 'g1') {
  const delegateDispose = vi.fn();
  const delegateWakeup = vi.fn(() => ({ dispose: delegateDispose }));
  const dispatch = vi.fn();
  const api = {
    apiVersion: 1, generation, capabilities,
    threads: { subscribe: vi.fn(() => ({ dispose() {} })), get: vi.fn(), list: vi.fn() },
    orchestrators: { list: vi.fn(async () => []), dispatch, ...(capabilities.includes('orchestrators.wakeup.delegate') ? { delegateWakeup } : {}) },
  } as unknown as ClaudeThreadsApiV1;
  return { api, delegateWakeup, delegateDispose, dispatch };
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

function makeLifecycle(client: ReturnType<typeof makeClient>, enabled = { value: true }) {
  const services: Array<WakeupServiceLike & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const lifecycle = new WakeupLifecycle({
    client, pluginId: 'threads-orchestrator', isEnabled: () => enabled.value,
    createService: () => { const s = { start: vi.fn(), stop: vi.fn() }; services.push(s); return s; },
  });
  return { lifecycle, services, enabled };
}

describe('WakeupLifecycle', () => {
  it('never starts and never claims the delegate when the capability is absent', () => {
    const { api, dispatch } = makeApi([]);
    const { lifecycle, services } = makeLifecycle(makeClient(api));
    lifecycle.start();
    expect(services).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing when the API is unavailable', () => {
    const { lifecycle, services } = makeLifecycle(makeClient(null));
    lifecycle.start();
    expect(services).toHaveLength(0);
  });

  it('claims the delegate with this plugin id and starts the service when capable and enabled', () => {
    const { api, delegateWakeup } = makeApi(['orchestrators.wakeup.delegate']);
    const { lifecycle, services } = makeLifecycle(makeClient(api));
    lifecycle.start();
    expect(delegateWakeup).toHaveBeenCalledWith({ pluginId: 'threads-orchestrator' });
    expect(services).toHaveLength(1);
    expect(services[0].start).toHaveBeenCalledTimes(1);
  });

  it('does not claim or start when the setting is off, and starts when it is turned on', () => {
    const { api, delegateWakeup } = makeApi(['orchestrators.wakeup.delegate']);
    const { lifecycle, services, enabled } = makeLifecycle(makeClient(api), { value: false });
    lifecycle.start();
    expect(delegateWakeup).not.toHaveBeenCalled();
    enabled.value = true;
    lifecycle.sync();
    expect(delegateWakeup).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(1);
  });

  it('disposes service and delegate when the setting is turned off', () => {
    const { api, delegateDispose } = makeApi(['orchestrators.wakeup.delegate']);
    const { lifecycle, services, enabled } = makeLifecycle(makeClient(api));
    lifecycle.start();
    enabled.value = false;
    lifecycle.sync();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    expect(delegateDispose).toHaveBeenCalledTimes(1);
  });

  it('sync is idempotent for an unchanged api and setting', () => {
    const { api, delegateWakeup } = makeApi(['orchestrators.wakeup.delegate']);
    const { lifecycle, services } = makeLifecycle(makeClient(api));
    lifecycle.start();
    lifecycle.sync();
    expect(delegateWakeup).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(1);
  });

  it('disposes on API stop and re-claims on a new generation', () => {
    const first = makeApi(['orchestrators.wakeup.delegate'], 'g1');
    const second = makeApi(['orchestrators.wakeup.delegate'], 'g2');
    const client = makeClient(first.api);
    const { lifecycle, services } = makeLifecycle(client);
    lifecycle.start();
    client.set(null);
    expect(first.delegateDispose).toHaveBeenCalledTimes(1);
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    client.set(second.api);
    expect(second.delegateWakeup).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(2);
  });

  it('does not start when the new generation lacks the capability', () => {
    const first = makeApi(['orchestrators.wakeup.delegate'], 'g1');
    const older = makeApi([], 'g2');
    const client = makeClient(first.api);
    const { lifecycle, services } = makeLifecycle(client);
    lifecycle.start();
    client.set(older.api);
    expect(services).toHaveLength(1);
    expect(services[0].stop).toHaveBeenCalledTimes(1);
  });

  it('dispose releases everything and unsubscribes from API changes', () => {
    const { api, delegateDispose } = makeApi(['orchestrators.wakeup.delegate']);
    const client = makeClient(api);
    const { lifecycle, services } = makeLifecycle(client);
    lifecycle.start();
    lifecycle.dispose();
    expect(services[0].stop).toHaveBeenCalledTimes(1);
    expect(delegateDispose).toHaveBeenCalledTimes(1);
    expect(client.listenerCount()).toBe(0);
    lifecycle.dispose();
    expect(delegateDispose).toHaveBeenCalledTimes(1);
  });

  it('does not start the service when claiming the delegate throws', () => {
    const { api, delegateWakeup } = makeApi(['orchestrators.wakeup.delegate']);
    delegateWakeup.mockImplementation(() => { throw new Error('already owned'); });
    const onWarn = vi.fn();
    const services: unknown[] = [];
    const lifecycle = new WakeupLifecycle({ client: makeClient(api), pluginId: 'p', isEnabled: () => true, onWarn, createService: () => { services.push(1); return { start() {}, stop() {} }; } });
    lifecycle.start();
    expect(services).toHaveLength(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('disposes the claimed delegate and stays inactive when the service fails to start', () => {
    const { api, delegateWakeup, delegateDispose } = makeApi(['orchestrators.wakeup.delegate']);
    (api.threads.subscribe as ReturnType<typeof vi.fn>).mockImplementation(() => { throw Object.assign(new Error('stopped'), { code: 'PLUGIN_UNAVAILABLE' }); });
    const onWarn = vi.fn();
    const lifecycle = new WakeupLifecycle({ client: makeClient(api), pluginId: 'p', isEnabled: () => true, onWarn });
    lifecycle.start();
    expect(delegateDispose).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledTimes(1);
    // A failed start leaves nothing active; a later sync retries with a fresh claim and disposes it again, never stacking tokens.
    lifecycle.sync();
    expect(delegateWakeup).toHaveBeenCalledTimes(2);
    expect(delegateDispose).toHaveBeenCalledTimes(2);
  });

  it('still disposes the delegate exactly once when the client unsubscribe throws; a second dispose is a no-op', () => {
    const { api, delegateDispose } = makeApi(['orchestrators.wakeup.delegate']);
    const client = makeClient(api);
    client.onChange = () => () => { throw new Error('unsubscribe failed'); };
    const lifecycle = new WakeupLifecycle({ client, pluginId: 'p', isEnabled: () => true, createService: () => ({ start() {}, stop() {} }) });
    lifecycle.start();
    try { lifecycle.dispose(); } catch { /* the unsubscribe error may propagate; the delegate must be released regardless */ }
    expect(delegateDispose).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.dispose()).not.toThrow();
    expect(delegateDispose).toHaveBeenCalledTimes(1);
  });
});
