import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { THREAD_ORCHESTRATOR_SKILL } from '../ThreadOrchestratorSkill';
import { PORTFOLIO_HEARTBEAT_PROMPT, PROJECT_HEARTBEAT_PROMPT } from '../HeartbeatService';
import { WakeupService } from '../WakeupService';
import { LOAD_SKILL_INSTRUCTION } from '../orchestratorPrompts';
import type { ClaudeThreadsApiV1, OrchestratorSnapshot, PublicThreadEvent } from '../ClaudeThreadsApiTypes';

const rawBody = THREAD_ORCHESTRATOR_SKILL.content;
const body = rawBody.replace(/\s+/g, ' ');

describe('Option B: Goal-Bounded Campaign Manager skill v3', () => {
  it('leads skill description with an explicit role directive under 1024 chars', () => {
    expect(THREAD_ORCHESTRATOR_SKILL.name).toBe('thread-orchestrator');
    expect(THREAD_ORCHESTRATOR_SKILL.description).toMatch(
      /^Load first when this thread is the Portfolio or a Project orchestrator/,
    );
    expect(THREAD_ORCHESTRATOR_SKILL.description).toMatch(/direct messages/i);
    expect(THREAD_ORCHESTRATOR_SKILL.description.length).toBeLessThanOrEqual(1024);
  });

  it('keeps the role-first check at the top of the skill', () => {
    expect(body).toContain(
      'First call `threads_get_current()` and inspect its Project. Never target your own thread with a tool in this skill.',
    );
  });

  it('enforces the Pure Orchestrator Boundary ("Manager, Never Worker")', () => {
    expect(body).toMatch(/Manager, Never Worker/);
    for (const forbidden of ['`Bash`', '`Edit`', '`Write`', 'worktrees', '`ScheduleWakeup`', '`Agent`']) {
      expect(body).toContain(forbidden);
    }
    expect(body).toMatch(/Agent Board worker thread/);
  });

  it('defines the complete 5-Channel Action Contract with explicit safety ceilings', () => {
    expect(body).toContain('`threads_create`');
    expect(body).toMatch(/one PR, bug, investigation, or verification gate per card/);
    expect(body).toMatch(/seed its Manager notes v2 with `threads_set_notes`/);

    expect(body).toContain('`threads_send_message`');
    expect(body).toMatch(/already-authorized Project or thread Campaign Goal/);
    expect(body).toMatch(/approve your own staged proposal/);
    expect(body).toMatch(/product\/UX\/scope questions addressed to Rick/);

    expect(body).toContain('`threads_set_proposed_reply`');
    expect(body).toContain('**Approve & Send**');

    expect(body).toContain('`threads_post_decision`');
    for (const irreversible of [
      'merge',
      'deploy',
      'release',
      'production migration',
      'force-push',
      'delete data',
      'spend money',
    ]) {
      expect(body.toLowerCase()).toContain(irreversible);
    }

    expect(body).toContain('`threads_set_notes`');
    expect(body).toMatch(/every reviewed, spawned, messaged, staged, or decided thread/);
  });

  it('specifies O(1) targeted event reads, O(N) triage heartbeats, and a 6-thread deep-review cap', () => {
    expect(body).toContain('`threads_get({ threadId, recentMessages: 10 })`');
    expect(body).toContain('`threads_list({ view: "triage" })`');
    expect(body).toContain('`triage.needsReview`');
    expect(body).toMatch(/at 6 changed threads per pass/);
    expect(body).toMatch(/prioritizing failed threads, waiting-on-Rick threads, and active campaign blockers/);
    expect(body).toMatch(/remaining unreviewed count/);
  });

  it('defines Tier 2 Cross-Thread Vault Ledger paths, MCP ledger tools, and triggers', () => {
    expect(body).toContain('`Products/<Project>/orchestrator-ledger.md`');
    expect(body).toContain('`Products/Portfolio/orchestrator-ledger.md`');
    expect(body).toContain('`threads_get_ledger`');
    expect(body).toContain('`threads_set_ledger`');
    expect(body).toMatch(/3\+ related threads/);
    expect(body).toMatch(/multi-PR batches\/waves/);
    expect(body).toMatch(/merge ordering/);
    expect(body).toContain('"Reset orchestrator session"');
  });

  it('includes Strategy in Manager notes v2 right below Thread outcome and supports disabled-Project note fallback', () => {
    expect(rawBody).toContain(
      [
        'Thread outcome: <specific result>',
        'Strategy: <current approach, key phases/gates, or tactical plan | missing>',
        'Done when: <observable completion condition>',
      ].join('\n'),
    );
    expect(body).toMatch(/`enabled: false`.*`threads_set_notes`.*`elevatedProjectId`|`threads_set_notes`.*`elevatedProjectId`.*`enabled: false`/);
  });
});

describe('Option B: slimmed triage/targeted orchestrator prompts & docs', () => {
  it('WakeupService composeMessage instructs using threads_get rather than a full reconciliation', async () => {
    let listener!: (event: PublicThreadEvent) => void;
    const timers: Array<() => void> = [];
    const dispatch = vi.fn(async () => ({ runId: 'r1' }));
    const portfolio: OrchestratorSnapshot = {
      id: 'portfolio',
      kind: 'portfolio',
      threadId: 'orch-portfolio',
      title: 'Portfolio',
      enabled: true,
    };
    const api = {
      apiVersion: 1,
      generation: 'g1',
      capabilities: ['orchestrators.ensure'],
      threads: {
        subscribe: vi.fn((fn: typeof listener) => {
          listener = fn;
          return { dispose: vi.fn() };
        }),
        get: vi.fn(async (id: string) => ({ id, title: 'Auth refactor', updatedAt: 42, messages: [] })),
      },
      orchestrators: {
        list: vi.fn(async () => [portfolio]),
        dispatch,
      },
    } as unknown as ClaudeThreadsApiV1;

    const svc = new WakeupService(api, {
      setTimeoutFn: cb => {
        timers.push(cb);
        return cb;
      },
      clearTimeoutFn: () => undefined,
    });
    svc.start();
    listener({ kind: 'run.failed', threadId: 't-auth', runId: 'r1', at: 1, error: { code: 'ERR', message: 'fail' } });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    timers.splice(0).forEach(cb => cb());
    for (let i = 0; i < 30; i++) await Promise.resolve();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const prompt = (dispatch.mock.calls[0] as unknown as [{ id: string }, { prompt: string }])[1].prompt;
    expect(prompt.startsWith(`${LOAD_SKILL_INSTRUCTION} New activity on 1 thread.`)).toBe(true);
    expect(prompt).toContain('threads_get');
    expect(prompt).toContain('full reconciliation');
  });

  it.each([
    ['portfolio', PORTFOLIO_HEARTBEAT_PROMPT],
    ['project', PROJECT_HEARTBEAT_PROMPT],
  ])('%s heartbeat prompt includes triage view, manager-not-worker delegation, and 6-thread cap while keeping safety rules', (_kind, prompt) => {
    expect(prompt.startsWith(`${LOAD_SKILL_INSTRUCTION} Heartbeat:`)).toBe(true);
    expect(prompt).toContain('threads_list({ view: "triage" })');
    expect(prompt).toMatch(/6 changed threads per pass/);
    expect(prompt).toMatch(/delegate repository work|manager, never worker/i);
    expect(prompt).toContain('keep at most one pending item per thread: a decision or a staged reply, never both');
    expect(prompt).toContain('never stage a bare go-ahead to merge, deploy, release, delete data, spend money');
    expect(prompt).toContain('never report "nothing needs action" while any thread is waiting or has a staged reply');
  });

  it('project heartbeat prompt preserves notify_portfolio guidance', () => {
    expect(PROJECT_HEARTBEAT_PROMPT).toContain('notify_portfolio');
  });

  it('README documents Option B Goal-Bounded Campaign Manager, orchestrator-ledger.md, threads_get/triage, and Charter compatibility', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toMatch(/Goal-Bounded Campaign Manager/);
    expect(readme).toContain('orchestrator-ledger.md');
    expect(readme).toContain('threads_get');
    expect(readme).toContain('view: "triage"');
    expect(readme).toMatch(/Charter/i);
  });
});
