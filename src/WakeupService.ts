/**
 * WakeupService: wakes Portfolio/Project orchestrator threads when other
 * threads finish a run.
 *
 * Port of Agent Threads core's OrchestratorWakeup, driven entirely through the
 * public Claude Threads API v1. Semantics preserved from core:
 * - only run.completed / run.failed trigger a wake-up
 * - completions are batched per destination bucket behind a debounce
 * - a generation counter per bucket lets invalidateBucket() retire queued and
 *   in-flight work so it can never be revived by later activity
 * - a Project dispatch that fails falls back to a summary-only portfolio ping
 *   that exposes no Project thread details
 *
 * Core stops pinging when this plugin claims the delegate (see
 * WakeupLifecycle); this class never runs without that claim.
 */
import type { ClaudeThreadsApiV1, Disposable, OrchestratorSnapshot, PublicThreadEvent } from './ClaudeThreadsApiTypes';

export interface WakeupServiceOptions {
  /** ms to wait after the last completion before flushing a batch. Default 12000. */
  debounceMs?: number;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Max THREAD_BUSY re-queues per batch before it is dropped (the heartbeat covers it). Default 3. */
  maxBusyRetries?: number;
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}

type Status = 'done' | 'error';
const DEFAULT_DEBOUNCE_MS = 12_000;
const DEFAULT_MAX_BUSY_RETRIES = 3;
const PORTFOLIO = 'portfolio';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

export class WakeupService {
  private subscription: Disposable | null = null;
  /** Bucket -> thread id -> most recent status since the last flush. */
  private pending = new Map<string, Map<string, Status>>();
  /** Buckets whose last dispatch hit THREAD_BUSY, waiting for the orchestrator's next completion. */
  private held = new Map<string, { entries: Map<string, Status>; retries: number }>();
  private timers = new Map<string, unknown>();
  private generations = new Map<string, number>();
  /** Bumped on stop() so in-flight async work from a previous run aborts. */
  private epoch = 0;

  constructor(private readonly api: ClaudeThreadsApiV1, private readonly options: WakeupServiceOptions = {}) {}

  start(): void {
    if (this.subscription) return;
    this.subscription = this.api.threads.subscribe(event => { void this.onEvent(event); });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.epoch++;
    for (const bucket of [...this.timers.keys()]) this.clearTimer(bucket);
    this.pending.clear();
    this.held.clear();
    this.generations.clear();
  }

  /** Permanently discards the bucket's queued and in-flight batch; later events start a fresh generation. */
  invalidateBucket(bucket: string): void {
    this.clearTimer(bucket);
    this.pending.delete(bucket);
    this.held.delete(bucket);
    this.generations.set(bucket, this.generation(bucket) + 1);
  }

  private generation(bucket: string): number { return this.generations.get(bucket) ?? 0; }

  private async onEvent(event: PublicThreadEvent): Promise<void> {
    // A stopped service must be inert even if the host keeps delivering events to a stale listener.
    if (!this.subscription) return;
    if (event.kind !== 'run.completed' && event.kind !== 'run.failed') return;
    const epoch = this.epoch;
    const status: Status = event.kind === 'run.completed' ? 'done' : 'error';
    try {
      const orchestrators = await this.api.orchestrators.list();
      if (epoch !== this.epoch) return;
      this.retryHeldBatches(event.threadId, orchestrators);
      const bucket = await this.resolveBucket(event.threadId, orchestrators);
      if (epoch !== this.epoch || !bucket) return;
      const entries = this.pending.get(bucket) ?? new Map<string, Status>();
      entries.set(event.threadId, status);
      this.pending.set(bucket, entries);
      this.armTimer(bucket);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** The orchestrator finishing a run is the cue to retry a batch it was too busy to take. */
  private retryHeldBatches(threadId: string, orchestrators: readonly OrchestratorSnapshot[]): void {
    for (const bucket of this.held.keys()) {
      if (orchestrators.some(o => o.id === bucket && o.threadId === threadId)) this.armTimer(bucket);
    }
  }

  private async resolveBucket(threadId: string, orchestrators: readonly OrchestratorSnapshot[]): Promise<string | undefined> {
    const own = orchestrators.find(o => o.threadId === threadId);
    if (own?.kind === 'portfolio') return undefined;
    if (own?.kind === 'project') return PORTFOLIO;
    const thread = await this.api.threads.get(threadId);
    if (!thread) return undefined;
    if (!thread.projectId) return PORTFOLIO;
    const project = orchestrators.find(o => o.kind === 'project' && o.projectId === thread.projectId);
    if (project?.enabled === false) return undefined;
    return `project:${thread.projectId}`;
  }

  private armTimer(bucket: string): void {
    this.clearTimer(bucket);
    const setTimeoutFn = this.options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.timers.set(bucket, setTimeoutFn(() => {
      this.timers.delete(bucket);
      void this.flush(bucket);
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
  }

  private clearTimer(bucket: string): void {
    if (!this.timers.has(bucket)) return;
    const clearTimeoutFn = this.options.clearTimeoutFn ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimeoutFn(this.timers.get(bucket));
    this.timers.delete(bucket);
  }

  private async flush(bucket: string): Promise<void> {
    const generation = this.generation(bucket);
    const epoch = this.epoch;
    const isCurrent = () => this.generation(bucket) === generation && this.epoch === epoch;

    // Snapshot before clearing: building the message reads this data.
    const held = this.held.get(bucket);
    this.held.delete(bucket);
    const entries = new Map<string, Status>(held?.entries ?? []);
    for (const [id, status] of this.pending.get(bucket) ?? []) entries.set(id, status);
    this.pending.delete(bucket);
    if (entries.size === 0) return;

    // Core re-checks orchestratorEnabled at flush; a Project disabled during the debounce is dropped silently.
    if (bucket.startsWith('project:') && await this.projectState(bucket) === 'disabled') return;
    if (!isCurrent()) return;

    let prompt: string;
    try {
      prompt = await this.composeMessage([...entries]);
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    if (!isCurrent()) return;

    try {
      await this.api.orchestrators.dispatch({ id: bucket }, { prompt, queueIfBusy: true });
    } catch (error) {
      if (!isCurrent()) return;
      if (errorCode(error) === 'THREAD_BUSY') { this.holdForRetry(bucket, entries, held?.retries ?? 0); return; }
      if (bucket.startsWith('project:')) {
        // Only an enabled Project whose orchestrator could not be reached gets the summary-only ping.
        // 'gone' (absent from list()) is ambiguous: deleted, disabled with a retired thread, or never created.
        // We deliberately DROP it: pinging the portfolio about a disabled Project would leak activity the user
        // turned off, and the 60-minute heartbeat is the backstop for the never-created case.
        if (await this.projectState(bucket) !== 'enabled' || !isCurrent()) return;
        await this.sendSummaryOnly(bucket, isCurrent);
      } else this.options.onError?.(error);
    }
  }

  /** Fresh read of the Project orchestrator: 'gone' when absent, 'disabled' when enabled === false. Unknown on list failure. */
  private async projectState(bucket: string): Promise<'enabled' | 'disabled' | 'gone' | 'unknown'> {
    try {
      const snapshot = (await this.api.orchestrators.list()).find(o => o.id === bucket);
      if (!snapshot) return 'gone';
      return snapshot.enabled === false ? 'disabled' : 'enabled';
    } catch {
      return 'unknown';
    }
  }

  private holdForRetry(bucket: string, entries: Map<string, Status>, retries: number): void {
    const maxRetries = this.options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;
    if (retries >= maxRetries) {
      this.options.onWarn?.(`Orchestrator wake-up: ${bucket} stayed busy, dropping ${entries.size} queued thread(s); the heartbeat covers them`);
      return;
    }
    // Newer activity that arrived meanwhile wins over the stale status.
    const merged = new Map(entries);
    for (const [id, status] of this.pending.get(bucket) ?? []) merged.set(id, status);
    this.held.set(bucket, { entries: merged, retries: retries + 1 });
  }

  private async sendSummaryOnly(bucket: string, isCurrent: () => boolean): Promise<void> {
    const projectId = bucket.slice('project:'.length);
    try {
      if (!isCurrent()) return;
      await this.api.orchestrators.dispatch(
        { id: PORTFOLIO },
        { prompt: `New activity in Project ${projectId} — the Project orchestrator could not be reached.`, queueIfBusy: true },
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async composeMessage(entries: ReadonlyArray<readonly [string, Status]>): Promise<string> {
    const lines = await Promise.all(entries.map(async ([threadId, status]) => {
      const thread = await this.api.threads.get(threadId).catch(() => null);
      const label = thread?.title ? `${threadId} "${thread.title}"` : threadId;
      const updatedAt = thread?.updatedAt ?? 'unavailable';
      return `- ${label} (${status}; updatedAt=${updatedAt})`;
    }));
    const noun = entries.length === 1 ? 'thread' : 'threads';
    return [
      `New activity on ${entries.length} ${noun}. Review only the named changed ${noun}; do not run a full reconciliation. The heartbeat handles missed activity.`,
      ...lines,
    ].join('\n');
  }
}
