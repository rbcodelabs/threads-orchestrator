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
