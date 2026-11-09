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

export const PORTFOLIO_HEARTBEAT_PROMPT = 'Heartbeat: reconcile activity missed by targeted event reviews across all threads. Do not reopen concluded work whose updatedAt is unchanged.';
export const PROJECT_HEARTBEAT_PROMPT = 'Heartbeat: reconcile Project activity missed by targeted event reviews. Do not reopen concluded work whose updatedAt is unchanged.';
export const DEFAULT_HEARTBEAT_MINUTES = 60;

export interface HeartbeatOptions {
  intervalMs: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export class HeartbeatService {
  private handle: unknown = null;
  private running = false;
  private inFlight = false;
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
    try {
      const orchestrators = await this.api.orchestrators.list();
      for (const o of orchestrators) {
        if (epoch !== this.epoch) return;
        if (!o.threadId || o.enabled === false) continue;
        const prompt = o.kind === 'portfolio' ? PORTFOLIO_HEARTBEAT_PROMPT : PROJECT_HEARTBEAT_PROMPT;
        try {
          await this.api.orchestrators.dispatch({ id: o.id }, { prompt, queueIfBusy: true });
        } catch (error) {
          if (epoch === this.epoch) this.options.onError?.(error);
        }
      }
    } catch (error) {
      if (epoch === this.epoch) this.options.onError?.(error);
    } finally {
      this.inFlight = false;
    }
  }
}
