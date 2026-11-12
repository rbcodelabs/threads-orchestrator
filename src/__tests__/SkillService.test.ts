import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SkillService } from '../SkillService';
import { THREAD_ORCHESTRATOR_SKILL } from '../ThreadOrchestratorSkill';
import type { ClaudeThreadsApiV1 } from '../ClaudeThreadsApiTypes';

function setup() {
  const dispose = vi.fn();
  const registerSkill = vi.fn(() => ({ dispose }));
  const api = { extensions: { registerSkill } } as unknown as ClaudeThreadsApiV1;
  return { api, registerSkill, dispose };
}

describe('bundled thread-orchestrator skill', () => {
  it('has the same name and description core shipped, and a body without frontmatter', () => {
    expect(THREAD_ORCHESTRATOR_SKILL.name).toBe('thread-orchestrator');
    expect(THREAD_ORCHESTRATOR_SKILL.description).toMatch(/^Scoped orchestrator for Agent Threads\./);
    expect(THREAD_ORCHESTRATOR_SKILL.description.length).toBeLessThanOrEqual(1024);
    expect(THREAD_ORCHESTRATOR_SKILL.name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(THREAD_ORCHESTRATOR_SKILL.content.startsWith('# Thread Orchestrator')).toBe(true);
    expect(THREAD_ORCHESTRATOR_SKILL.content).not.toMatch(/^---/);
    expect(THREAD_ORCHESTRATOR_SKILL.content.length).toBeLessThan(100_000);
  });

  it('is exactly the SKILL.md body core used to ship (heartbeat/event-ping procedure intact)', () => {
    const body = THREAD_ORCHESTRATOR_SKILL.content;
    for (const phrase of ['**Event ping:**', '**Heartbeat:**', '**Direct message:**', 'Manager notes v2', 'Approve & Send']) expect(body).toContain(phrase);
    // Wake/heartbeat prompts address the skill by behaviour, never by a namespaced id, so registration name drift cannot break them.
    const source = readFileSync(new URL('../WakeupService.ts', import.meta.url), 'utf8') + readFileSync(new URL('../HeartbeatService.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/thread-orchestrator:|\/thread-orchestrator/);
  });
});

describe('thread-link convention (producer side of the Agent Threads dock thread links)', () => {
  const body = THREAD_ORCHESTRATOR_SKILL.content;
  const HEADING = '## Naming threads in replies to Rick';
  /** The section text from its heading to the next `## ` heading (or the end). */
  function section(): string {
    const start = body.indexOf(HEADING);
    expect(start, `missing heading ${HEADING}`).toBeGreaterThanOrEqual(0);
    const rest = body.slice(start + HEADING.length);
    const next = rest.search(/\n## /);
    // Markdown is hard-wrapped: compare on single-spaced text.
    return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ');
  }

  it('documents the [[thread:<id>|Title]] marker with the exact id field the tools return', () => {
    const s = section();
    expect(s).toContain('[[thread:<id>|Title]]');
    expect(s).toMatch(/`id` field/);
    expect(s).toMatch(/threads_list/);
  });

  it('forbids inventing, abbreviating, renaming or reusing a stale id', () => {
    const s = section();
    expect(s).toMatch(/never invent/i);
    expect(s).toMatch(/never abbreviate or rename the id/i);
    expect(s).toMatch(/unless a tool returned it in this run/i);
    expect(s).toMatch(/shorten only the label/i);
  });

  it('says the title goes on one line with [, ], | and line breaks replaced by spaces', () => {
    expect(section()).toMatch(/one line, with any \[, \], \| or line breaks in the title replaced by spaces/);
  });

  it('has an explicit positive list (own conversation messages to Rick) and a plain-text negative list', () => {
    const s = section();
    expect(s).toMatch(/only in your own conversation messages to Rick/i);
    for (const where of ['direct answers', 'event/heartbeat summaries', 'goal questions']) expect(s).toContain(where);
    expect(s).toMatch(/PLAIN TEXT/);
    for (const where of ['manager notes', 'proposed replies', 'threads_post_decision', 'tool arguments', 'code blocks']) expect(s).toContain(where);
    expect(s).toContain('dangling wikilink');
  });

  it('the goal-question template uses the marker, so the sections do not conflict', () => {
    expect(body).toMatch(/What outcome do you want from \[\[thread:<id>\|<thread title>\]\]/);
  });

  it('the documented example round-trips through a copy of the consumer regex', () => {
    // Mirrors THREAD_LINK in agent-threads src/orchestratorDockModel.ts (unmerged: rbcodelabs/agent-threads#899/#903/#904).
    const THREAD_LINK = /\[\[thread:([^\]|\n]+?)(?:\\?\|([^\]\n]+))?\]\]/g;
    const example = section().match(/`(\[\[thread:[^`]*\]\])`/g)?.map((m) => m.slice(1, -1)).find((m) => !m.includes('<id>'));
    expect(example, 'the section needs a concrete example like [[thread:abc-123|Deploy fix]]').toBeTruthy();
    const m = [...example!.matchAll(THREAD_LINK)];
    expect(m).toHaveLength(1);
    expect(m[0][1].trim()).toBe('abc-123');
    expect(m[0][2].trim()).toBe('Deploy fix');
    // The template form must NOT be mistaken for a real id-bearing link by prose readers, but the regex accepts it syntactically.
    expect('[[thread:<id>|Title]]'.match(THREAD_LINK)).toHaveLength(1);
  });
});

describe('SkillService', () => {
  it('registers the skill under this plugin id on start and disposes it on stop', () => {
    const { api, registerSkill, dispose } = setup();
    const service = new SkillService(api, { pluginId: 'threads-orchestrator' });
    service.start();
    expect(registerSkill).toHaveBeenCalledWith({ pluginId: 'threads-orchestrator' }, THREAD_ORCHESTRATOR_SKILL);
    expect(dispose).not.toHaveBeenCalled();
    service.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent and stop is idempotent', () => {
    const { api, registerSkill, dispose } = setup();
    const service = new SkillService(api, { pluginId: 'p' });
    service.start(); service.start();
    expect(registerSkill).toHaveBeenCalledTimes(1);
    service.stop(); service.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a throwing registration propagates so the lifecycle can warn and retry', () => {
    const { api, registerSkill } = setup();
    registerSkill.mockImplementation(() => { throw new Error('name owned by another plugin'); });
    expect(() => new SkillService(api, { pluginId: 'p' }).start()).toThrow('name owned');
  });
});
