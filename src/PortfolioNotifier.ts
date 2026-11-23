/**
 * PortfolioNotifier: contributes the `notify_portfolio` agent tool so a Project
 * orchestrator can send the Portfolio orchestrator a one-way FYI.
 *
 * Why a tool and not `threads_send_message`: core's coordination scope blocks a
 * Project orchestrator from writing to a thread outside its Project, and the
 * Portfolio thread has none. The tool dispatches through the public
 * `orchestrators.dispatch({ id: 'portfolio' })` instead, the same path
 * WakeupService uses.
 *
 * Guarantees, all enforced here rather than left to the model:
 * - the caller must be an enabled Project orchestrator (per orchestrators.list())
 * - the Portfolio is resolved on every call and its thread id is never cached
 * - no Portfolio means nothing is created and nothing is sent
 * - per Project: 1 message per 5 minutes, burst of 3 (token bucket); excess is dropped
 * - kind + subject repeats inside 30 minutes are not resent
 * - one-way: the prompt says no reply is needed, and WakeupService ignores both
 *   the Portfolio's and Project orchestrators' own run events, so a delivery
 *   cannot trigger another wake-up
 * - for kind decision/needs_you with a threadId, the host (never the sender) looks the thread up and appends a compact
 *   read-only block of its pending decisions, built only from core data; any lookup problem just omits the block
 * - every failure comes back as a short result string; nothing throws into the model
 */
import type { AgentToolContribution, AgentToolResult, ClaudeThreadsApiV1, OrchestratorSnapshot, PublicPendingDecision } from './ClaudeThreadsApiTypes';

export const NOTIFY_PORTFOLIO_TOOL_NAME = 'notify_portfolio';
export const NOTIFY_KINDS = ['error', 'needs_you', 'decision', 'completed', 'pr_ready', 'release', 'blocked', 'lost_thread'] as const;
export type NotifyKind = typeof NOTIFY_KINDS[number];

const MAX_SUMMARY_CHARS = 400;
const MAX_SHORT_FIELD_CHARS = 200;
const DECISIONS_CAPABILITY = 'threads.pendingDecisions';
const DECISION_KINDS: readonly string[] = ['decision', 'needs_you'];
const LOOKUP_TIMEOUT_MS = 1500;
const MAX_BLOCK_CHARS = 1000;
const BLOCK_TITLE = 'Pending decisions (read-only, from the thread):';
const BURST = 3;
const REFILL_MS = 5 * 60_000;
const DEDUPE_WINDOW_MS = 30 * 60_000;

export interface PortfolioNotifierOptions {
  pluginId: string;
  now?: () => number;
  onWarn?: (message: string) => void;
}

const DESCRIPTION = [
  'Send the Portfolio orchestrator a one-way FYI about something in your Project that Rick or the portfolio should know.',
  'Send it as soon as you notice: a thread waiting on Rick, a decision posted, a thread finished, a PR ready for review or merged, a release shipped,',
  'a thread failed or hit an error you cannot fix, work blocked on something outside the Project, or a thread archived or deleted that you did not do.',
  'Lead the summary with what needs Rick and what is staged. Do not use it when nothing changed, for progress notes or title changes.',
  'For kind decision or needs_you with a threadId, the thread\'s pending decision options are attached automatically from the thread itself, so do not paste options into the summary.',
  'No reply comes back. Repeats of the same kind and subject are dropped, and each Project is rate limited.',
].join(' ');

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...NOTIFY_KINDS], description: 'What happened: error, needs_you, decision, completed, pr_ready, release, blocked, or lost_thread.' },
    subject: { type: 'string', description: 'Thread id, PR url or a short key naming what this is about. Used to de-duplicate.' },
    summary: { type: 'string', description: `One or two sentences, at most ${MAX_SUMMARY_CHARS} characters (longer is truncated).` },
    threadId: { type: 'string', description: 'Optional: the related thread id.' },
    url: { type: 'string', description: 'Optional: a PR or release url.' },
  },
  required: ['kind', 'subject', 'summary'],
};

function result(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

/** One line, so a model-supplied value cannot forge extra header lines in the portfolio prompt. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Decision text is untrusted: one line, and a field name followed by a colon is defused so it cannot read as a header. */
function decisionText(value: string, max: number): string {
  return oneLine(value.replace(/\b(Kind|Subject|Summary|Thread|URL|FYI|Pending decisions)\s*:/gi, '$1 -'), max);
}

function formatDecision(d: PublicPendingDecision): string {
  const options = d.options.slice(0, 4).map((o, i) => `${i + 1}) ${decisionText(o.label, 30)}${o.description ? ` - ${decisionText(o.description, 50)}` : ''}`).join('; ');
  const flags = [
    ...(d.recommended ? [`Recommended: ${decisionText(d.recommended, 30)}`] : []),
    ...(d.multiSelect ? ['multi-select'] : []),
    ...(d.allowOther ? ['free-text allowed'] : []),
  ];
  return [`- [${decisionText(d.id, 40)}] ${decisionText(d.header, 60)}: ${decisionText(d.question, 160)}`, `  Options: ${[options, ...flags].join('; ')}`].join('\n');
}

/** Newest first; whole decisions are dropped (never cut mid-entry) once the cap is reached, and the omission is counted. */
function formatDecisionBlock(decisions: readonly PublicPendingDecision[]): string {
  const newestFirst = [...decisions].sort((a, b) => b.createdAt - a.createdAt);
  const reserve = '\n(+99 more)'.length;
  let block = BLOCK_TITLE;
  let shown = 0;
  for (const d of newestFirst) {
    const entry = `\n${formatDecision(d)}`;
    if (block.length + entry.length + (shown + 1 < newestFirst.length ? reserve : 0) > MAX_BLOCK_CHARS && shown > 0) break;
    block += entry;
    shown++;
  }
  return shown < newestFirst.length ? `${block}\n(+${newestFirst.length - shown} more)` : block;
}

interface Bucket { credit: number; updatedAt: number }

export class PortfolioNotifier {
  private registration: { dispose: () => void } | null = null;
  private readonly buckets = new Map<string, Bucket>();
  private readonly sent = new Map<string, number>();

  constructor(private readonly api: ClaudeThreadsApiV1, private readonly options: PortfolioNotifierOptions) {}

  start(): void {
    if (this.registration) return;
    const register = this.api.extensions?.registerAgentTool;
    if (typeof register !== 'function') throw new Error('this Agent Threads version has no extensions.registerAgentTool');
    const outcome = register.call(this.api.extensions, { pluginId: this.options.pluginId }, this.contribution());
    if (!outcome.success) throw new Error(`core rejected the ${NOTIFY_PORTFOLIO_TOOL_NAME} tool (${outcome.status}): ${outcome.message}`);
    this.registration = outcome;
  }

  stop(): void {
    const registration = this.registration;
    this.registration = null;
    this.buckets.clear();
    this.sent.clear();
    registration?.dispose();
  }

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }

  private contribution(): AgentToolContribution {
    return {
      name: NOTIFY_PORTFOLIO_TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      alwaysLoad: true,
      // A one-way FYI to an orchestrator we own; an approval prompt would stall an unattended orchestrator turn.
      requiresApproval: false,
      invoke: (threadId, args) => this.invoke(threadId, args),
    };
  }

  /** Never throws: every failure becomes a short result string. */
  async invoke(callerThreadId: string, args: unknown): Promise<AgentToolResult> {
    try {
      return await this.run(callerThreadId, args);
    } catch (error) {
      return result(`Could not notify the portfolio: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private async run(callerThreadId: string, rawArgs: unknown): Promise<AgentToolResult> {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return result('Invalid arguments: expected an object with kind, subject and summary.', true);
    const args = rawArgs as Record<string, unknown>;
    const kind = args.kind;
    if (typeof kind !== 'string' || !(NOTIFY_KINDS as readonly string[]).includes(kind)) return result(`Invalid kind. Use one of: ${NOTIFY_KINDS.join(', ')}.`, true);
    if (typeof args.subject !== 'string' || !args.subject.trim()) return result('Invalid arguments: subject must be a non-empty string.', true);
    if (typeof args.summary !== 'string' || !args.summary.trim()) return result('Invalid arguments: summary must be a non-empty string.', true);
    for (const optional of ['threadId', 'url'] as const) {
      if (args[optional] !== undefined && typeof args[optional] !== 'string') return result(`Invalid arguments: ${optional} must be a string.`, true);
    }
    const subject = oneLine(args.subject, MAX_SHORT_FIELD_CHARS);
    const summary = oneLine(args.summary, MAX_SUMMARY_CHARS);
    const relatedThread = typeof args.threadId === 'string' && args.threadId.trim() ? oneLine(args.threadId, MAX_SHORT_FIELD_CHARS) : undefined;
    const url = typeof args.url === 'string' && args.url.trim() ? oneLine(args.url, MAX_SHORT_FIELD_CHARS) : undefined;

    const orchestrators = await this.api.orchestrators.list();
    const caller = orchestrators.find(o => o.kind === 'project' && o.enabled && o.threadId !== '' && o.threadId === callerThreadId);
    if (!caller) return result('Refused: notify_portfolio can only be called by an enabled project orchestrator thread.', true);
    // Resolved on every call: the Portfolio thread id is repointed when it is archived or recreated, so it is never cached.
    const portfolio = orchestrators.find(o => o.kind === 'portfolio' && o.threadId !== '');
    if (!portfolio) return result('No portfolio orchestrator exists, so nothing was sent. Nothing was created.');

    // The lookup is awaited before the dedupe section on purpose, so the no-await guarantee below still holds.
    const decisionsBlock = DECISION_KINDS.includes(kind) && relatedThread ? await this.pendingDecisionsBlock(relatedThread) : undefined;

    // From here to the dispatch there is no await, so two simultaneous identical calls cannot both pass.
    const now = this.now();
    this.pruneSent(now);
    const key = `${kind}\u0000${subject}`;
    if (this.sent.has(key)) return result(`Already sent: the same kind and subject went to the portfolio within the last 30 minutes. Not sent again.`);
    const bucketKey = caller.projectId ?? caller.id;
    if (!this.takeToken(bucketKey, now)) return result('Dropped: rate limit reached for this project (1 message per 5 minutes, burst of 3). It was not sent; the heartbeat remains the safety net.');
    this.sent.set(key, now);

    try {
      await this.api.orchestrators.dispatch({ id: 'portfolio' }, { prompt: this.prompt(caller, kind, subject, summary, relatedThread, url, decisionsBlock), queueIfBusy: true });
    } catch (error) {
      // A failed delivery must not burn the token or block a retry.
      this.sent.delete(key);
      this.returnToken(bucketKey);
      const code = errorCode(error);
      if (code === 'THREAD_BUSY') return result('The portfolio orchestrator is busy and the message was not delivered. Try again later; the heartbeat remains the safety net.');
      if (code === 'ORCHESTRATOR_NOT_FOUND') return result('No portfolio orchestrator exists, so nothing was sent. Nothing was created.');
      this.options.onWarn?.(`notify_portfolio dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      return result(`Could not deliver to the portfolio: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return result('Sent to the portfolio orchestrator. No reply is expected.');
  }

  private prompt(caller: OrchestratorSnapshot, kind: string, subject: string, summary: string, relatedThread?: string, url?: string, decisionsBlock?: string): string {
    const project = caller.projectId ?? caller.id;
    return [
      `FYI from the ${project} project orchestrator (${oneLine(caller.title, MAX_SHORT_FIELD_CHARS)}, ${caller.threadId}), no reply needed.`,
      `Kind: ${kind}`,
      `Subject: ${subject}`,
      `Summary: ${summary}`,
      ...(relatedThread ? [`Thread: ${relatedThread}`] : []),
      ...(url ? [`URL: ${url}`] : []),
      ...(decisionsBlock ? [decisionsBlock] : []),
    ].join('\n');
  }

  /** Best effort, bounded, never throws: any problem means no block and the ping goes out as before. */
  private async pendingDecisionsBlock(threadId: string): Promise<string | undefined> {
    if (!this.api.capabilities?.includes(DECISIONS_CAPABILITY)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        this.api.threads.get(threadId),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS); }),
      ]);
      const decisions = snapshot?.pendingDecisions;
      return Array.isArray(decisions) && decisions.length > 0 ? formatDecisionBlock(decisions) : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private pruneSent(now: number): void {
    for (const [key, at] of this.sent) if (now - at >= DEDUPE_WINDOW_MS) this.sent.delete(key);
  }

  /**
   * Token bucket in integer milliseconds of credit (capacity BURST * REFILL_MS, one token costs REFILL_MS), so refill
   * arithmetic is exact. Refilled lazily from the injected clock.
   */
  private takeToken(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? { credit: BURST * REFILL_MS, updatedAt: now };
    const credit = Math.min(BURST * REFILL_MS, bucket.credit + Math.max(0, now - bucket.updatedAt));
    if (credit < REFILL_MS) { this.buckets.set(key, { credit, updatedAt: now }); return false; }
    this.buckets.set(key, { credit: credit - REFILL_MS, updatedAt: now });
    return true;
  }

  private returnToken(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.credit = Math.min(BURST * REFILL_MS, bucket.credit + REFILL_MS);
  }
}
