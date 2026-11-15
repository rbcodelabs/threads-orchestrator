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

  it('lets a decision relay through and marks the thread answered', () => {
    expect(body).toContain('This relay is allowed even though you already posted for that `updatedAt`');
    expect(body).toContain('Staged: answered (decision <id>, relayed)');
    expect(body).toContain('Rick in a direct message to stage or re-stage');
  });

  it('keeps routine drafts out of the irreversible-action rule', () => {
    expect(body).toContain('Routine drafts, local edits, branch pushes, and ordinary replies are not irreversible');
  });

  it('points Rick to Settings when orchestrator management is unavailable', () => {
    expect(body).toContain('Orchestrator management is not available in this context');
    expect(body).toContain('point Rick to Settings → Threads Orchestrator → Orchestrators');
    expect(body).not.toContain('Settings → Orchestrators');
  });

  it('treats legacy notes without the Staged field as none and keeps elevation read-only', () => {
    expect(body).toContain('treat a missing field as `none`');
    expect(body).toContain('it is for reads only');
  });

  it('allows at most one pending item per thread: a decision or a staged reply, never both', () => {
    expect(body).toContain('A thread holds **at most one** pending item for Rick');
    expect(body).toContain('If `pendingDecisions` is non-empty, do not call `threads_set_proposed_reply` for that thread');
    expect(body).toContain('call `threads_clear_proposed_reply` first, then post the decision');
  });

  it('reads proposedReply and pendingDecisions before staging or posting and trusts them over memory', () => {
    expect(body).toContain('Before every `threads_set_proposed_reply` or `threads_post_decision` on a thread');
    expect(body).toContain('That state is authoritative over anything you remember staging or posting');
    expect(body).toContain('Treat the state as unknown only when that tool is missing');
  });

  it('posts the decision first and relays only after the answer, then marks the notes answered', () => {
    expect(body).toContain('post the decision and stage nothing in that turn');
    expect(body).toContain('Only after Rick has answered it');
    expect(body).toContain('`Staged: answered (decision <id>, relayed)`');
  });

  it('puts answer-independent preparation in option descriptions or the report, not a staged reply', () => {
    expect(body).toContain("goes in the decision's option descriptions or in your report, not in a separate staged reply");
  });

  it('does not clear or post over a pending reply that another orchestrator owns', () => {
    expect(body).toContain('A staged reply owned by another orchestrator is not yours to clear');
  });

  it('treats absent proposedReply/pendingDecisions as nothing pending unless threads_post_decision is missing', () => {
    expect(body).toContain('Absent fields mean nothing is pending');
    expect(body).toContain('the host omits `proposedReply` and `pendingDecisions` when nothing is pending');
    expect(body).toContain('Treat the state as **unknown** only when that tool is missing');
    expect(body).toContain('tell Rick plainly that you cannot read pending state on this host');
    expect(body).not.toContain('post a decision only if the manager notes show nothing staged');
    expect(body).not.toContain('treat the pending state as unknown (do not stage or post on a guess');
  });

  it('allows one threads_list read on an event ping before staging or posting', () => {
    expect(body).toContain('the one exception is a single `threads_list()` read to check `proposedReply` and `pendingDecisions`');
  });

  it('relay with no reply needed marks answered and no-action; a needed relay clears a stale reply first', () => {
    expect(body).toContain('only when the thread needs to know it');
    expect(body).toContain('first clear any stale staged reply you own');
    expect(body).toContain('stage nothing and set `Staged: answered (decision <id>)` and `Disposition: no-action`');
  });

  it('gives a moot open decision an escape and counts a decision answer as authorization', () => {
    expect(body).toContain('`threads_clear_decision` for any open decision you posted that is now moot');
    expect(body).toContain('his answer to a decision you posted that named this action');
  });

  it('still forbids sending', () => {
    expect(body).toContain('**Never send.**');
    expect(body).toContain('You may never send a proposed reply yourself');
  });

  it('includes Strategy between Thread outcome and Done when in Manager notes v2', () => {
    const raw = THREAD_ORCHESTRATOR_SKILL.content;
    const v2Start = raw.indexOf('## Manager notes v2');
    expect(v2Start).toBeGreaterThanOrEqual(0);
    const v2Next = raw.slice(v2Start + 1).search(/\n## /);
    const v2Section = v2Next === -1 ? raw.slice(v2Start) : raw.slice(v2Start, v2Start + 1 + v2Next);

    const outcomeIdx = v2Section.indexOf('Thread outcome: <specific result>');
    const strategyIdx = v2Section.indexOf('Strategy: <current approach, key phases/gates, or tactical plan | missing>');
    const doneWhenIdx = v2Section.indexOf('Done when: <observable completion condition>');

    expect(outcomeIdx).toBeGreaterThanOrEqual(0);
    expect(strategyIdx).toBeGreaterThan(outcomeIdx);
    expect(doneWhenIdx).toBeGreaterThan(strategyIdx);
    expect(v2Section.replace(/\s+/g, ' ')).toContain('passing `elevatedProjectId` set to that Project\'s ID to `threads_set_notes`');
  });

  it('extracts strategy during goal acquisition and refreshes Strategy when the tactical approach shifts', () => {
    const raw = THREAD_ORCHESTRATOR_SKILL.content;
    const nestedStart = raw.indexOf('## Nested goal contracts');
    const goalStart = raw.indexOf('## Goal acquisition');
    const v2Start = raw.indexOf('## Manager notes v2');
    expect(nestedStart).toBeGreaterThanOrEqual(0);
    expect(goalStart).toBeGreaterThan(nestedStart);
    expect(v2Start).toBeGreaterThan(goalStart);

    const nestedSection = raw.slice(nestedStart, goalStart).replace(/\s+/g, ' ');
    const goalSection = raw.slice(goalStart, v2Start).replace(/\s+/g, ' ');

    expect(nestedSection).toContain('manager notes define the concrete result this workstream contributes, its strategy, its done condition, and its constraints');
    expect(goalSection).toContain('Extract the desired outcome, strategy (current tactical approach, key phases/gates, or execution plan; `missing` if not yet established)');
    expect(goalSection).toContain('without requiring a redundant goal interview when the outcome and done condition are clear');
    expect(goalSection).toContain('updated whenever the thread\'s tactical approach materially changes');
    expect(body).toContain('Refresh `Strategy` whenever the thread\'s tactical approach, key phases/gates, or execution plan materially shifts');
  });

  it('permits Portfolio threads_set_notes with elevatedProjectId when a Project orchestrator is disabled, while blocking overwrites when enabled', () => {
    const raw = THREAD_ORCHESTRATOR_SKILL.content;
    const scopeStart = raw.indexOf('## Scope and authority');
    const errorsStart = raw.indexOf('### Out-of-scope errors');
    const nextHeading = raw.indexOf('## Project orchestrators');
    expect(scopeStart).toBeGreaterThanOrEqual(0);
    expect(errorsStart).toBeGreaterThan(scopeStart);
    expect(nextHeading).toBeGreaterThan(errorsStart);

    const scopeSection = raw.slice(scopeStart, errorsStart).replace(/\s+/g, ' ');
    const errorsSection = raw.slice(errorsStart, nextHeading).replace(/\s+/g, ' ');

    expect(scopeSection).toContain('while a Project\'s orchestrator is enabled, Project manager notes belong to that Project orchestrator and Portfolio elevation cannot overwrite them');
    expect(scopeSection).toContain('When a Project\'s orchestrator is **disabled** (`enabled: false` in `threads_list_orchestrators()`), the Portfolio Orchestrator may write `threads_set_notes` for threads in that Project by passing `elevatedProjectId` set to the Project\'s ID');
    expect(scopeSection).toContain('once the Project orchestrator is enabled, it resumes sole ownership of that Project\'s manager notes');
    expect(scopeSection).toContain('Staging replies and posting decisions for Project threads remain with the Project orchestrator unless Rick explicitly asks otherwise');

    expect(errorsSection).toContain('While a Project\'s orchestrator is enabled, it is for reads only');
    expect(errorsSection).toContain('do not overwrite that Project orchestrator\'s manager notes');
    expect(errorsSection).toContain('When a Project\'s orchestrator is **disabled** (`enabled: false` in `threads_list_orchestrators()`), the Portfolio Orchestrator may also pass `elevatedProjectId` set to the Project\'s ID on `threads_set_notes`');
  });
});
