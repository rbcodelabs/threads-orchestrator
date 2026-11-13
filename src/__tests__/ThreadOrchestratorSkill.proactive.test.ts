import { describe, expect, it } from 'vitest';
import { THREAD_ORCHESTRATOR_SKILL } from '../ThreadOrchestratorSkill';

const body = THREAD_ORCHESTRATOR_SKILL.content.replace(/\s+/g, ' ');

describe('thread-orchestrator skill: proactive waiting-on-Rick rules', () => {
  it('records what was staged against which updatedAt and never re-stages for the same updatedAt', () => {
    expect(body).toContain('Staged for update: <thread.updatedAt copied exactly | none>');
    expect(body).toContain('never stage again, even if the proposed reply or decision is now gone');
  });

  it('gives goal intake precedence and keeps the Portfolio out of Project threads', () => {
    expect(body).toContain('Goal intake comes first');
    expect(body).toContain('A Portfolio Orchestrator does not stage or post for threads that belong to a Project');
  });

  it('never stages a bare go-ahead for an irreversible action', () => {
    expect(body).toContain('never stage a bare "yes" or "go ahead"');
    expect(body).toContain("Rick's own earlier words authorize this exact action");
  });

  it('allows no-action only for a stale question and says age alone is not stale', () => {
    expect(body).toContain('The one exception is a **stale question**');
    expect(body).toContain('Age alone does not make a question stale.');
  });

  it('still forbids sending', () => {
    expect(body).toContain('**Never send.**');
    expect(body).toContain('You may never send a proposed reply yourself');
  });
});
