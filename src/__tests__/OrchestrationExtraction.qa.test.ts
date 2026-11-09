import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceLifecycle } from '../ServiceLifecycle';
import { HeartbeatService, heartbeatIntervalMs, PORTFOLIO_HEARTBEAT_PROMPT, PROJECT_HEARTBEAT_PROMPT } from '../HeartbeatService';
import { SkillService } from '../SkillService';
import { THREAD_ORCHESTRATOR_SKILL } from '../ThreadOrchestratorSkill';
import { readFileSync } from 'node:fs';
import { REQUIRED_CORE_CAPABILITIES, type ClaudeThreadsApiV1, type OrchestratorSnapshot } from '../ClaudeThreadsApiTypes';

afterEach(() => { vi.useRealTimers(); });

function makeClient(initial: ClaudeThreadsApiV1 | null) {
  let current = initial;
  const listeners = new Set<(api: ClaudeThreadsApiV1 | null) => void>();
  return {
    current: () => current,
    onChange: (l: (api: ClaudeThreadsApiV1 | null) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set: (api: ClaudeThreadsApiV1 | null) => { current = api; listeners.forEach(l => l(api)); },
  };
}

function makeApi(opts: { capabilities?: readonly string[]; generation?: string; list?: OrchestratorSnapshot[] } = {}) {
  const live = new Set<number>();
  let n = 0;
  const registerSkill = vi.fn(() => { const id = ++n; live.add(id); return { dispose: () => { live.delete(id); } }; });
  const dispatch = vi.fn(async () => ({ runId: 'r' }));
  const api = {
    apiVersion: 1, generation: opts.generation ?? 'g1', capabilities: opts.capabilities ?? REQUIRED_CORE_CAPABILITIES,
    threads: { subscribe: vi.fn(() => ({ dispose: vi.fn() })), get: vi.fn() },
    orchestrators: { list: vi.fn(async () => opts.list ?? []), dispatch },
    extensions: { registerSkill },
  } as unknown as ClaudeThreadsApiV1;
  return { api, live, registerSkill, dispatch };
}

describe('QA: required capabilities gate every orchestration service (no fallback)', () => {
  for (const missing of REQUIRED_CORE_CAPABILITIES) {
    it(`a core lacking ${missing} starts none of the wake-up, heartbeat and skill services and warns exactly once`, () => {
      const a = makeApi({ capabilities: REQUIRED_CORE_CAPABILITIES.filter(c => c !== missing) });
      const client = makeClient(a.api);
      const warnings: string[] = [];
      const warnOnce = { generation: null as string | null };
      const started: string[] = [];
      const lifecycles = ['wakeup', 'heartbeat', 'skill'].map(label => new ServiceLifecycle({
        client, label, isEnabled: () => true, onWarn: m => warnings.push(m), warnOnce,
        createService: () => ({ start: () => started.push(label), stop: () => undefined }),
      }));
      lifecycles.forEach(l => l.start());
      lifecycles.forEach(l => l.sync());
      expect(started, 'no service may start without the capability').toEqual([]);
      expect(warnings, 'one shared warning for the whole generation').toHaveLength(1);
      expect(warnings[0]).toContain(missing);
      expect(a.registerSkill).not.toHaveBeenCalled();
      expect(a.dispatch).not.toHaveBeenCalled();
    });
  }

  it('a capability-less generation followed by a capable one starts the services (upgrade without reload)', () => {
    const client = makeClient(makeApi({ capabilities: [], generation: 'old' }).api);
    const next = makeApi({ generation: 'new' });
    const lifecycle = new ServiceLifecycle({ client, label: 'skill', isEnabled: () => true, createService: api => new SkillService(api, { pluginId: 'threads-orchestrator' }) });
    lifecycle.start();
    expect(next.registerSkill).not.toHaveBeenCalled();
    client.set(next.api);
    expect(next.live.size).toBe(1);
    lifecycle.dispose();
  });
});

describe('QA: skill registration never leaks', () => {
  it('API stop, generation swap, and dispose each leave zero live registrations', () => {
    const g1 = makeApi({ generation: 'g1' });
    const g2 = makeApi({ generation: 'g2' });
    const client = makeClient(g1.api);
    const lifecycle = new ServiceLifecycle({ client, label: 'skill', isEnabled: () => true, createService: api => new SkillService(api, { pluginId: 'threads-orchestrator' }) });
    lifecycle.start();
    expect(g1.live.size).toBe(1);
    client.set(g2.api); // direct swap, no null between
    expect(g1.live.size, 'old generation registration disposed').toBe(0);
    expect(g2.live.size).toBe(1);
    client.set(null);
    expect(g2.live.size).toBe(0);
    client.set(g2.api);
    expect(g2.live.size).toBe(1);
    lifecycle.dispose();
    expect(g2.live.size).toBe(0);
    client.set(g1.api); // a late event after dispose must not re-register
    expect(g1.live.size).toBe(0);
  });

  it('registers with this plugin id and a spec that satisfies the core validation limits', () => {
    const a = makeApi();
    new SkillService(a.api, { pluginId: 'threads-orchestrator' }).start();
    const [owner, spec] = a.registerSkill.mock.calls[0] as unknown as [{ pluginId: string }, typeof THREAD_ORCHESTRATOR_SKILL];
    expect(owner).toEqual({ pluginId: 'threads-orchestrator' });
    expect(spec.name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(spec.description.length).toBeGreaterThan(0);
    expect(spec.description.length).toBeLessThanOrEqual(1024);
    expect(spec.content.length).toBeGreaterThan(0);
    expect(spec.content.length).toBeLessThanOrEqual(100_000);
  });

  it('skill body does not smuggle its own frontmatter or an unterminated code fence that would break the SKILL.md core writes', () => {
    const body = THREAD_ORCHESTRATOR_SKILL.content;
    expect(body.trimStart().startsWith('---')).toBe(false);
    expect((body.match(/^```/gm) ?? []).length % 2, 'balanced code fences').toBe(0);
  });
});

describe('QA: heartbeat timer lifecycle', () => {
  const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'tp', title: 'P', enabled: true } as OrchestratorSnapshot;
  const proj = { id: 'project:a', kind: 'project', projectId: 'a', threadId: 'ta', title: 'A', enabled: true } as OrchestratorSnapshot;

  it('a stale timer callback firing after stop() lists and dispatches nothing', async () => {
    const a = makeApi({ list: [portfolio, proj] });
    let cb: (() => void) | null = null;
    const svc = new HeartbeatService(a.api, { intervalMs: 1000, setIntervalFn: f => { cb = f; return 1; }, clearIntervalFn: () => undefined });
    svc.start();
    svc.stop();
    cb!();
    await new Promise(r => setTimeout(r, 0));
    expect(a.api.orchestrators.list).not.toHaveBeenCalled();
    expect(a.dispatch).not.toHaveBeenCalled();
  });

  it('stop() is idempotent and the same instance can start again with a fresh timer', () => {
    const a = makeApi();
    const set = vi.fn(() => 1); const clear = vi.fn();
    const svc = new HeartbeatService(a.api, { intervalMs: 1000, setIntervalFn: set, clearIntervalFn: clear });
    svc.stop();
    svc.start(); svc.stop(); svc.stop();
    svc.start();
    expect(set).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('with real timers: start arms exactly one timer, stop and lifecycle dispose leave none, and no dispatch happens after', async () => {
    vi.useFakeTimers();
    const a = makeApi({ list: [portfolio, proj] });
    const client = makeClient(a.api);
    const lifecycle = new ServiceLifecycle({ client, label: 'hb', isEnabled: () => true, createService: api => new HeartbeatService(api, { intervalMs: heartbeatIntervalMs(5) }) });
    lifecycle.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(a.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount(), 'interval only; the per-tick watchdog is cleared').toBe(1);
    lifecycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(a.dispatch).toHaveBeenCalledTimes(2);
  });

  it('lifecycle.restart() after an interval change re-arms with the new period and clears the old timer', async () => {
    vi.useFakeTimers();
    const a = makeApi({ list: [portfolio] });
    const minutes = { value: 60 };
    const lifecycle = new ServiceLifecycle({ client: makeClient(a.api), label: 'hb', isEnabled: () => true, createService: api => new HeartbeatService(api, { intervalMs: heartbeatIntervalMs(minutes.value) }) });
    lifecycle.start();
    minutes.value = 10;
    lifecycle.restart();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(a.dispatch).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it('only the exact core prompts with queueIfBusy are sent: portfolio prompt to portfolio, project prompt to projects, nothing else in the payload', async () => {
    const a = makeApi({ list: [portfolio, proj] });
    let cb: (() => void) | null = null;
    new HeartbeatService(a.api, { intervalMs: 1, setIntervalFn: f => { cb = f; return 1; } }).start();
    cb!();
    await new Promise(r => setTimeout(r, 0));
    expect(a.dispatch.mock.calls as unknown[]).toEqual([
      [{ id: 'portfolio' }, { prompt: PORTFOLIO_HEARTBEAT_PROMPT, queueIfBusy: true }],
      [{ id: 'project:a' }, { prompt: PROJECT_HEARTBEAT_PROMPT, queueIfBusy: true }],
    ]);
  });

  it('a disabled Portfolio entry (defensive) and a threadless one are both skipped', async () => {
    const a = makeApi({ list: [{ ...portfolio, enabled: false }, { ...proj, threadId: '' }] });
    let cb: (() => void) | null = null;
    new HeartbeatService(a.api, { intervalMs: 1, setIntervalFn: f => { cb = f; return 1; } }).start();
    cb!();
    await new Promise(r => setTimeout(r, 0));
    expect(a.dispatch).not.toHaveBeenCalled();
  });

  it('interval clamp rejects NaN, strings, negatives and Infinity', () => {
    expect(heartbeatIntervalMs(NaN)).toBe(60 * 60_000);
    expect(heartbeatIntervalMs('10')).toBe(60 * 60_000);
    expect(heartbeatIntervalMs(-5)).toBe(5 * 60_000);
    expect(heartbeatIntervalMs(Infinity)).toBe(60 * 60_000);
    expect(heartbeatIntervalMs(0)).toBe(5 * 60_000);
  });
});

describe('QA: settings defaults', () => {
  it('heartbeat defaults to on at 60 minutes and wake-ups to on (settings.ts imports obsidian, so read as text)', () => {
    const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8');
    const defaults = src.slice(src.indexOf('export const DEFAULT_SETTINGS'));
    expect(defaults).toMatch(/wakeOrchestratorsOnActivity: true/);
    expect(defaults).toMatch(/heartbeatEnabled: true/);
    expect(defaults).toMatch(/heartbeatIntervalMinutes: 60/);
  });
});

// QA FINDING (observed in the real-app run, scenario W): on a vault with no Portfolio orchestrator, the first thread
// that finishes makes WakeupService dispatch to {id:'portfolio'}; core's dispatch resolution then CREATES the Portfolio
// orchestrator thread and starts a turn on it. Released core only woke an orchestrator that already existed
// (resolveTarget('portfolio') returned settings.orchestratorThreadId, undefined => no ping), and HeartbeatService
// documents "never creates an orchestrator". Wake-up must follow the same rule for the Portfolio.
import { WakeupService } from '../WakeupService';
describe('QA: wake-up must not create a Portfolio orchestrator that does not exist (parity with released core and with the heartbeat)', () => {
  it('a plain thread finishing while list() has no Portfolio orchestrator dispatches nothing', async () => {
    let listener!: (e: unknown) => void;
    const timers: Array<() => void> = [];
    const dispatch = vi.fn(async () => ({ runId: 'r' }));
    const api = {
      threads: { subscribe: vi.fn((fn: typeof listener) => { listener = fn; return { dispose: vi.fn() }; }), get: vi.fn(async (id: string) => ({ id, title: 'Worker', updatedAt: 1, messages: [] })) },
      orchestrators: { list: vi.fn(async () => []), dispatch },
    } as unknown as ClaudeThreadsApiV1;
    const svc = new WakeupService(api, { setTimeoutFn: cb => { timers.push(cb); return cb; }, clearTimeoutFn: () => undefined });
    svc.start();
    listener({ kind: 'run.completed', threadId: 'w1', runId: 'r', at: 1 });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    timers.splice(0).forEach(cb => cb());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(dispatch, 'core would auto-create the Portfolio orchestrator and start a Claude turn on it').not.toHaveBeenCalled();
  });
});
