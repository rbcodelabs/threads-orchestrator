/**
 * HeartbeatService: periodically asks the Portfolio orchestrator and every
 * enabled Project orchestrator to reconcile activity missed by event wake-ups.
 *
 * Replaces Agent Threads' removed heartbeat cron items (same prompts, same
 * interval default). A timer is used on purpose: the heartbeat is by
 * definition the time-based backstop for missed events, so there is no
 * SDK/API event to subscribe to instead. One timer, cleared on stop.
 *
 * Like core, it never creates an orchestrator: no thread, no heartbeat.
 */
import type { ClaudeThreadsApiV1 } from './ClaudeThreadsApiTypes';

export const PORTFOLIO_HEARTBEAT_PROMPT = 'Heartbeat: reconcile activity missed by targeted event reviews across all threads. Do not reopen concluded work whose updatedAt is unchanged. Stage a proposed reply for every thread waiting on Rick that has a clear recommendation (never send it), post a decision for genuine forks, and lead the report with threads needing Rick and what is staged; never report "nothing needs action" while any thread is waiting or has a staged reply.';
export const PROJECT_HEARTBEAT_PROMPT = 'Heartbeat: reconcile Project activity missed by targeted event reviews. Do not reopen concluded work whose updatedAt is unchanged. Stage a proposed reply for every thread waiting on Rick that has a clear recommendation (never send it), post a decision for genuine forks, and lead the report with threads needing Rick and what is staged; never report "nothing needs action" while any thread is waiting or has a staged reply.';
export const DEFAULT_HEARTBEAT_MINUTES = 60;
export const MIN_HEARTBEAT_MINUTES = 5;
export const MAX_HEARTBEAT_MINUTES = 1440;
const DEFAULT_TICK_TIMEOUT_MS = 120_000;

/** Non-numbers fall back to the default; out-of-range values clamp (below 5 -> 5, above 1440 -> 1440). */
export function heartbeatIntervalMs(minutes: unknown): number {
  const m = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : DEFAULT_HEARTBEAT_MINUTES;
  return Math.min(MAX_HEARTBEAT_MINUTES, Math.max(MIN_HEARTBEAT_MINUTES, m)) * 60_000;
}

export interface HeartbeatOptions {
  intervalMs: number;
  /** A tick running longer than this is abandoned so one hung call cannot stall later ticks. Default 2 minutes. */
  tickTimeoutMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export class HeartbeatService {
  private handle: unknown = null;
  private running = false;
  private inFlight = false;
  private tickSeq = 0;
  /** Bumped on stop() so an in-flight tick never dispatches afterwards. */
  private epoch = 0;

  constructor(private readonly api: ClaudeThreadsApiV1, private readonly options: HeartbeatOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const set = this.options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.handle = set(() => { void this.tick(); }, this.options.intervalMs);
  }

  stop(): void {
    this.epoch++;
    if (!this.running) return;
    this.running = false;
    const clear = this.options.clearIntervalFn ?? (h => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.running) return;
    this.inFlight = true;
    const epoch = this.epoch;
    const tickId = ++this.tickSeq;
    const isCurrent = () => epoch === this.epoch && tickId === this.tickSeq;
    const watchdog = setTimeout(() => {
      if (tickId !== this.tickSeq) return;
      this.tickSeq++; // invalidates the hung tick: it can dispatch nothing more
      this.inFlight = false;
      this.options.onWarn?.('Orchestrator heartbeat tick timed out and was abandoned');
    }, this.options.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS);
    try {
      const orchestrators = await this.api.orchestrators.list();
      for (const o of orchestrators) {
        if (!isCurrent()) return;
        if (!o.threadId || o.enabled === false) continue;
        const prompt = o.kind === 'portfolio' ? PORTFOLIO_HEARTBEAT_PROMPT : PROJECT_HEARTBEAT_PROMPT;
        try {
          await this.api.orchestrators.dispatch({ id: o.id }, { prompt, queueIfBusy: true });
        } catch (error) {
          if (isCurrent()) this.options.onError?.(error);
        }
      }
    } catch (error) {
      if (isCurrent()) this.options.onError?.(error);
    } finally {
      clearTimeout(watchdog);
      if (tickId === this.tickSeq) this.inFlight = false;
    }
  }
}
