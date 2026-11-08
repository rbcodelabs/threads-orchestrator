import { WAKEUP_DELEGATE_CAPABILITY, type ClaudeThreadsApiV1, type Disposable } from './ClaudeThreadsApiTypes';
import { WakeupService } from './WakeupService';

export interface WakeupServiceLike { start(): void; stop(): void }

interface ApiSource {
  current(): ClaudeThreadsApiV1 | null;
  onChange(listener: (api: ClaudeThreadsApiV1 | null) => void): () => void;
}

export interface WakeupLifecycleOptions {
  client: ApiSource;
  pluginId: string;
  /** The "Wake orchestrators on thread activity" setting. */
  isEnabled: () => boolean;
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
  /** Test seam. */
  createService?: (api: ClaudeThreadsApiV1) => WakeupServiceLike;
}

/**
 * Owns the delegate claim and the WakeupService for the current API
 * generation. The service only runs while core has acknowledged that this
 * plugin owns wake-ups; on older cores (no capability) core keeps pinging.
 */
export class WakeupLifecycle {
  private active: { api: ClaudeThreadsApiV1; delegate: Disposable; service: WakeupServiceLike } | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly options: WakeupLifecycleOptions) {}

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.client.onChange(() => this.sync());
    this.sync();
  }

  /** Reconciles state with the current API and setting. Idempotent. */
  sync(): void {
    if (this.disposed) return;
    const api = this.options.client.current();
    const wanted = !!api && this.options.isEnabled() && api.capabilities.includes(WAKEUP_DELEGATE_CAPABILITY) && typeof api.orchestrators.delegateWakeup === 'function';
    if (this.active && (!wanted || this.active.api !== api)) this.release();
    if (!wanted || !api || this.active) return;

    let delegate: Disposable;
    try {
      delegate = api.orchestrators.delegateWakeup!({ pluginId: this.options.pluginId });
    } catch (error) {
      this.options.onWarn?.(`Could not claim orchestrator wake-up delegation: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let service: WakeupServiceLike;
    try {
      service = this.options.createService?.(api) ?? new WakeupService(api, { onWarn: this.options.onWarn, onError: this.options.onError });
      service.start();
    } catch (error) {
      // Do not leak the claim: it would keep core's wake-ups suppressed with nothing sending them.
      delegate.dispose();
      this.options.onWarn?.(`Could not start orchestrator wake-up service: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.active = { api, delegate, service };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.release();
  }

  private release(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.service.stop();
    active.delegate.dispose();
  }
}
