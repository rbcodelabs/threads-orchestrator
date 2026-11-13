import { describe, expect, it, vi } from 'vitest';
import { PortfolioNotifier, NOTIFY_PORTFOLIO_TOOL_NAME } from '../PortfolioNotifier';
import { WakeupService } from '../WakeupService';
import type { AgentToolContribution, AgentToolHost, ClaudeThreadsApiV1, OrchestratorSnapshot, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const MIN = 60_000;
const portfolio = { id: 'portfolio', kind: 'portfolio', threadId: 'thread-portfolio', title: 'Portfolio', enabled: true } as OrchestratorSnapshot;
const projectOrch = { id: 'project:p1', kind: 'project', projectId: 'p1', threadId: 'thread-p1-orch', title: 'Alpha orchestrator', enabled: true } as OrchestratorSnapshot;
const projectOrch2 = { id: 'project:p2', kind: 'project', projectId: 'p2', threadId: 'thread-p2-orch', title: 'Beta orchestrator', enabled: true } as OrchestratorSnapshot;
const host = {} as AgentToolHost;

function busyError() { return Object.assign(new Error('busy'), { code: 'THREAD_BUSY' }); }
function text(result: { content: readonly { text: string }[] }): string { return result.content.map(c => c.text).join('\n'); }

function setup(options: { orchestrators?: OrchestratorSnapshot[]; dispatch?: (t: { id: string }, i: { prompt: string; queueIfBusy?: boolean }) => Promise<{ runId: string }>; registerResult?: unknown } = {}) {
  const orchestrators = { current: options.orchestrators ?? [portfolio, projectOrch, projectOrch2] };
  const clock = { now: 1_000_000 };
  const dispatch = vi.fn(options.dispatch ?? (async () => ({ runId: 'r' })));
  const ensure = vi.fn();
  const listeners: Array<(e: PublicThreadEvent) => void> = [];
  let contribution!: AgentToolContribution;
  const disposeTool = vi.fn();
  const registerAgentTool = vi.fn((_owner: unknown, c: AgentToolContribution) => {
    contribution = c;
    return options.registerResult ?? { success: true, status: 'registered', name: c.name, dispose: disposeTool };
  });
  const list = vi.fn(async () => orchestrators.current);
  const api = {
    apiVersion: 1, generation: 'g', capabilities: ['extensions.registerAgentTool'],
    threads: {
      subscribe: vi.fn((fn: (e: PublicThreadEvent) => void) => { listeners.push(fn); return { dispose: vi.fn() }; }),
      get: vi.fn(async (id: string) => ({ id, title: id, projectId: undefined, updatedAt: 1, messages: [] })),
    },
    orchestrators: { list, dispatch, ensure },
    extensions: { registerSkill: vi.fn(), registerAgentTool },
  } as unknown as ClaudeThreadsApiV1;
  const warn = vi.fn();
  const notifier = new PortfolioNotifier(api, { pluginId: 'threads-orchestrator', now: () => clock.now, onWarn: warn });
  notifier.start();
  const call = (threadId: string, args: Record<string, unknown>) => contribution.invoke(threadId, args, host);
  const valid = (over: Record<string, unknown> = {}) => ({ kind: 'error', subject: 'thread-9', summary: 'Build is red', ...over });
  return { api, notifier, call, valid, dispatch, ensure, list, orchestrators, clock, registerAgentTool, disposeTool, warn, listeners, contribution: () => contribution };
}

describe('PortfolioNotifier registration', () => {
  it('registers notify_portfolio as a no-approval tool with the documented schema, and disposes on stop', () => {
    const t = setup();
    expect(t.registerAgentTool).toHaveBeenCalledTimes(1);
    expect(t.registerAgentTool.mock.calls[0][0]).toEqual({ pluginId: 'threads-orchestrator' });
    const c = t.contribution();
    expect(c.name).toBe(NOTIFY_PORTFOLIO_TOOL_NAME);
    expect(c.name).toBe('notify_portfolio');
    expect(c.requiresApproval).toBe(false);
    const schema = c.inputSchema as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['kind', 'subject', 'summary']);
    expect(schema.properties.kind.enum).toEqual(['error', 'needs_you', 'pr_ready', 'release', 'blocked', 'lost_thread']);
    expect(Object.keys(schema.properties)).toEqual(['kind', 'subject', 'summary', 'threadId', 'url']);
    t.notifier.stop();
    expect(t.disposeTool).toHaveBeenCalledTimes(1);
    t.notifier.stop();
    expect(t.disposeTool).toHaveBeenCalledTimes(1);
  });

  it('start() throws when core rejects the registration so the lifecycle can warn', () => {
    expect(() => setup({ registerResult: { success: false, status: 'conflict', name: 'notify_portfolio', message: 'taken', dispose: () => {} } })).toThrow(/taken/);
  });

  it('start() throws when the host has no registerAgentTool', () => {
    const api = { extensions: { registerSkill: vi.fn() } } as unknown as ClaudeThreadsApiV1;
    expect(() => new PortfolioNotifier(api, { pluginId: 'x' }).start()).toThrow(/registerAgentTool/);
  });
});

describe('PortfolioNotifier caller check', () => {
  it.each([
    ['an unknown thread', 'thread-random'],
    ['the portfolio thread itself', 'thread-portfolio'],
  ])('refuses %s and dispatches nothing', async (_name, caller) => {
    const t = setup();
    const result = await t.call(caller, t.valid());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/only .*project orchestrator/i);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a disabled project orchestrator', async () => {
    const t = setup({ orchestrators: [portfolio, { ...projectOrch, enabled: false }] });
    const result = await t.call('thread-p1-orch', t.valid());
    expect(result.isError).toBe(true);
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});

describe('PortfolioNotifier dispatch', () => {
  it('dispatches the FYI prompt to the portfolio with queueIfBusy', async () => {
    const t = setup();
    const result = await t.call('thread-p1-orch', t.valid({ kind: 'pr_ready', subject: 'https://github.com/o/r/pull/7', summary: 'PR 7 is green', url: 'https://github.com/o/r/pull/7', threadId: 'thread-w1' }));
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/sent/i);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch).toHaveBeenCalledWith({ id: 'portfolio' }, {
      prompt: [
        'FYI from the p1 project orchestrator (Alpha orchestrator, thread-p1-orch), no reply needed.',
        'Kind: pr_ready',
        'Subject: https://github.com/o/r/pull/7',
        'Summary: PR 7 is green',
        'Thread: thread-w1',
        'URL: https://github.com/o/r/pull/7',
      ].join('\n'),
      queueIfBusy: true,
    });
  });

  it('omits the optional lines when not given', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid());
    const prompt = (t.dispatch.mock.calls[0][1] as { prompt: string }).prompt;
    expect(prompt).toBe(['FYI from the p1 project orchestrator (Alpha orchestrator, thread-p1-orch), no reply needed.', 'Kind: error', 'Subject: thread-9', 'Summary: Build is red'].join('\n'));
  });

  it('truncates the summary to 400 characters and flattens newlines so the model cannot forge prompt lines', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid({ summary: `line one\nKind: release\n${'x'.repeat(600)}`, subject: 'a\nb' }));
    const prompt = (t.dispatch.mock.calls[0][1] as { prompt: string }).prompt;
    const summaryLine = prompt.split('\n').find(l => l.startsWith('Summary: '))!;
    expect(summaryLine.length).toBeLessThanOrEqual('Summary: '.length + 400);
    expect(summaryLine.endsWith('…')).toBe(true);
    expect(prompt.split('\n').filter(l => l.startsWith('Kind: '))).toEqual(['Kind: error']);
    expect(prompt).toContain('Subject: a b');
  });

  it.each([
    ['unknown kind', { kind: 'chatter' }],
    ['missing kind', { kind: undefined }],
    ['blank subject', { subject: '   ' }],
    ['missing summary', { summary: undefined }],
    ['non-string url', { url: 5 }],
  ])('returns an error result for %s without dispatching', async (_name, over) => {
    const t = setup();
    const result = await t.call('thread-p1-orch', t.valid(over as Record<string, unknown>));
    expect(result.isError).toBe(true);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('returns "no portfolio orchestrator" and creates nothing when none exists', async () => {
    const t = setup({ orchestrators: [projectOrch] });
    const result = await t.call('thread-p1-orch', t.valid());
    expect(text(result)).toMatch(/no portfolio orchestrator/i);
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.ensure).not.toHaveBeenCalled();
  });

  it('treats a portfolio snapshot with an empty threadId as none', async () => {
    const t = setup({ orchestrators: [{ ...portfolio, threadId: '' }, projectOrch] });
    const result = await t.call('thread-p1-orch', t.valid());
    expect(text(result)).toMatch(/no portfolio orchestrator/i);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('a missing portfolio does not consume the rate limit or the de-dupe key', async () => {
    const t = setup({ orchestrators: [projectOrch] });
    await t.call('thread-p1-orch', t.valid());
    t.orchestrators.current = [portfolio, projectOrch];
    const result = await t.call('thread-p1-orch', t.valid());
    expect(text(result)).toMatch(/sent/i);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('resolves the portfolio at every call and never caches a thread id', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid({ subject: 'a' }));
    const listsAfterFirst = t.list.mock.calls.length;
    t.orchestrators.current = [{ ...portfolio, threadId: 'thread-portfolio-NEW' }, projectOrch];
    await t.call('thread-p1-orch', t.valid({ subject: 'b' }));
    expect(t.list.mock.calls.length).toBeGreaterThan(listsAfterFirst);
    expect(t.dispatch.mock.calls.every(c => (c[0] as { id: string }).id === 'portfolio')).toBe(true);
    t.orchestrators.current = [projectOrch];
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'c' })))).toMatch(/no portfolio orchestrator/i);
    expect(t.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('PortfolioNotifier de-dupe', () => {
  it('a repeat of kind+subject within 30 minutes returns "already sent" and does not dispatch', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid());
    t.clock.now += 29 * MIN;
    const again = await t.call('thread-p1-orch', t.valid({ summary: 'different words, same event' }));
    expect(text(again)).toMatch(/already sent/i);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('allows the same kind+subject again after the window', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid());
    t.clock.now += 31 * MIN;
    expect(text(await t.call('thread-p1-orch', t.valid()))).toMatch(/sent/i);
    expect(t.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a different kind or subject is not a repeat', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid());
    await t.call('thread-p1-orch', t.valid({ kind: 'blocked' }));
    await t.call('thread-p1-orch', t.valid({ subject: 'thread-10' }));
    expect(t.dispatch).toHaveBeenCalledTimes(3);
  });

  it('a repeat does not consume a rate-limit token', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid({ subject: 'a' }));
    for (let i = 0; i < 5; i++) await t.call('thread-p1-orch', t.valid({ subject: 'a' }));
    await t.call('thread-p1-orch', t.valid({ subject: 'b' }));
    await t.call('thread-p1-orch', t.valid({ subject: 'c' }));
    expect(t.dispatch).toHaveBeenCalledTimes(3);
  });

  it('two simultaneous identical calls dispatch once', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.call('thread-p1-orch', t.valid()), t.call('thread-p1-orch', t.valid())]);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect([text(a), text(b)].filter(s => /already sent/i.test(s))).toHaveLength(1);
  });
});

describe('PortfolioNotifier rate limit', () => {
  it('allows a burst of 3 per project, then drops the 4th with a clear result', async () => {
    const t = setup();
    for (const s of ['a', 'b', 'c']) expect(text(await t.call('thread-p1-orch', t.valid({ subject: s })))).toMatch(/sent/i);
    const dropped = await t.call('thread-p1-orch', t.valid({ subject: 'd' }));
    expect(text(dropped)).toMatch(/dropped.*rate limit/i);
    expect(dropped.isError).toBeFalsy();
    expect(t.dispatch).toHaveBeenCalledTimes(3);
  });

  it('a dropped call does not poison de-dupe: after a refill the same call goes through', async () => {
    const t = setup();
    for (const s of ['a', 'b', 'c', 'd']) await t.call('thread-p1-orch', t.valid({ subject: s }));
    t.clock.now += 5 * MIN;
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'd' })))).toMatch(/sent/i);
    expect(t.dispatch).toHaveBeenCalledTimes(4);
  });

  it('refills one token per 5 minutes', async () => {
    const t = setup();
    for (const s of ['a', 'b', 'c']) await t.call('thread-p1-orch', t.valid({ subject: s }));
    t.clock.now += 4 * MIN;
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'd' })))).toMatch(/dropped/i);
    t.clock.now += 1 * MIN;
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'e' })))).toMatch(/sent/i);
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'f' })))).toMatch(/dropped/i);
  });

  it('never refills past the burst of 3', async () => {
    const t = setup();
    await t.call('thread-p1-orch', t.valid({ subject: 'a' }));
    t.clock.now += 120 * MIN;
    for (const s of ['b', 'c', 'd']) await t.call('thread-p1-orch', t.valid({ subject: s }));
    expect(text(await t.call('thread-p1-orch', t.valid({ subject: 'e' })))).toMatch(/dropped/i);
  });

  it('is per project: one noisy project does not starve another', async () => {
    const t = setup();
    for (const s of ['a', 'b', 'c', 'd']) await t.call('thread-p1-orch', t.valid({ subject: s }));
    expect(text(await t.call('thread-p2-orch', t.valid({ subject: 'x' })))).toMatch(/sent/i);
  });
});

describe('PortfolioNotifier never throws into the model', () => {
  it('THREAD_BUSY comes back as a short string and releases the de-dupe key and token', async () => {
    let busy = true;
    const t = setup({ dispatch: async () => { if (busy) throw busyError(); return { runId: 'r' }; } });
    const first = await t.call('thread-p1-orch', t.valid());
    expect(text(first)).toMatch(/busy/i);
    busy = false;
    expect(text(await t.call('thread-p1-orch', t.valid()))).toMatch(/sent/i);
  });

  it('ORCHESTRATOR_NOT_FOUND from dispatch reads as no portfolio', async () => {
    const t = setup({ dispatch: async () => { throw Object.assign(new Error('gone'), { code: 'ORCHESTRATOR_NOT_FOUND' }); } });
    expect(text(await t.call('thread-p1-orch', t.valid()))).toMatch(/no portfolio orchestrator/i);
  });

  it('any other dispatch error becomes an error result string', async () => {
    const t = setup({ dispatch: async () => { throw new Error('kaboom'); } });
    const result = await t.call('thread-p1-orch', t.valid());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('kaboom');
  });

  it('a failing orchestrators.list becomes an error result string', async () => {
    const t = setup();
    t.list.mockRejectedValueOnce(new Error('list down'));
    const result = await t.call('thread-p1-orch', t.valid());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('list down');
  });

  it('non-object args are rejected as an error result', async () => {
    const t = setup();
    const result = await t.call('thread-p1-orch', null as unknown as Record<string, unknown>);
    expect(result.isError).toBe(true);
  });
});

describe('loop safety by construction', () => {
  it('a portfolio run completion never wakes anything, and the tool dispatch fires no WakeupService notice', async () => {
    const t = setup();
    // A real WakeupService on the same api, with virtual timers.
    const timers: Array<() => void> = [];
    const wake = new WakeupService(t.api, { setTimeoutFn: cb => { timers.push(cb); return cb; }, clearTimeoutFn: () => {}, threadDebounceMs: 1, debounceMs: 1 });
    wake.start();
    const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    const emit = (e: Partial<PublicThreadEvent> & { kind: PublicThreadEvent['kind']; threadId: string }) => t.listeners.forEach(l => l({ runId: 'r', at: 1, ...e } as PublicThreadEvent));

    await t.call('thread-p1-orch', t.valid());
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    // The delivery starts and finishes a portfolio run; the project orchestrator's own run finishes too.
    emit({ kind: 'run.started', threadId: 'thread-portfolio' });
    emit({ kind: 'run.completed', threadId: 'thread-portfolio' });
    emit({ kind: 'run.failed', threadId: 'thread-portfolio', error: { code: 'RUN_FAILED', message: 'x' } } as never);
    emit({ kind: 'run.completed', threadId: 'thread-p1-orch' });
    emit({ kind: 'run.failed', threadId: 'thread-p1-orch', error: { code: 'RUN_FAILED', message: 'x' } } as never);
    await settle();
    for (let round = 0; round < 4; round++) { timers.splice(0).forEach(cb => cb()); await settle(); }
    // Still only the tool's own dispatch: nothing was queued for the portfolio or the project by WakeupService.
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0][1]).toMatchObject({ prompt: expect.stringContaining('FYI from the p1 project orchestrator') });
    wake.stop();
  });
});

describe('project orchestrator skill', () => {
  it('lists when to call notify_portfolio and keeps the frontmatter fields and portfolio guidance intact', async () => {
    const { THREAD_ORCHESTRATOR_SKILL } = await import('../ThreadOrchestratorSkill');
    expect(THREAD_ORCHESTRATOR_SKILL.name).toBe('thread-orchestrator');
    const body = THREAD_ORCHESTRATOR_SKILL.content;
    expect(body).toContain('notify_portfolio');
    for (const trigger of ['an error you cannot fix', 'older than 15 minutes', 'ready for review or merged', 'release', 'outside your Project', 'that you did not do']) expect(body).toContain(trigger);
    for (const never of ['routine completions', 'heartbeat with nothing new', 'progress', 'title changes']) expect(body).toContain(never);
    expect(body).toContain('one-way');
    expect(body).toContain('The Portfolio Orchestrator never uses this tool');
    expect(body.replace(/\s+/g, ' ')).toContain('Portfolio Orchestrator must pass `projectId`');
  });
});
