import { REQUIRED_CORE_CAPABILITIES, type ClaudeThreadsApiV1 } from './ClaudeThreadsApiTypes';

export interface ServiceLike { start(): void; stop(): void }

interface ApiSource {
  current(): ClaudeThreadsApiV1 | null;
  onChange(listener: (api: ClaudeThreadsApiV1 | null) => void): () => void;
}

export interface ServiceLifecycleOptions {
  client: ApiSource;
  /** Human label for warnings, e.g. "orchestrator wake-up". */
  label: string;
  /** The user-facing on/off setting for this service. */
  isEnabled: () => boolean;
  createService: (api: ClaudeThreadsApiV1) => ServiceLike;
  onWarn?: (message: string) => void;
  /** Shared between lifecycles so the missing-capability warning is logged once per API generation, not once per service. */
  warnOnce?: { generation: string | null };
}

/**
 * Runs one service against the current Agent Threads API generation: started
 * when the API is present, has every required core capability and the setting
 * is on; stopped on API stop/swap, setting off, or dispose. There is no
 * fallback for a core lacking the capabilities (core and plugin ship together).
 */
export class ServiceLifecycle {
  private active: { api: ClaudeThreadsApiV1; service: ServiceLike } | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly warned: { generation: string | null };
  private disposed = false;

  constructor(private readonly options: ServiceLifecycleOptions) { this.warned = options.warnOnce ?? { generation: null }; }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.client.onChange(() => this.sync());
    this.sync();
  }

  /** Reconciles state with the current API and setting. Idempotent. */
  sync(): void {
    if (this.disposed) return;
    const api = this.options.client.current();
    const missing = api ? REQUIRED_CORE_CAPABILITIES.filter(c => !api.capabilities.includes(c)) : [];
    const wanted = !!api && missing.length === 0 && this.options.isEnabled();
    if (this.active && (!wanted || this.active.api !== api)) this.release();
    if (api && missing.length > 0 && this.warned.generation !== api.generation) {
      this.warned.generation = api.generation;
      this.options.onWarn?.(`The ${this.options.label} is off: this Agent Threads version lacks required capabilities (${missing.join(', ')}). Update Agent Threads.`);
    }
    if (!wanted || !api || this.active) return;
    try {
      const service = this.options.createService(api);
      service.start();
      this.active = { api, service };
    } catch (error) {
      this.options.onWarn?.(`Could not start the ${this.options.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops and recreates the service, e.g. after its options (interval) changed. */
  restart(): void {
    this.release();
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe?.();
    } finally {
      this.unsubscribe = null;
      this.release();
    }
  }

  private release(): void {
    const active = this.active;
    this.active = null;
    try {
      active?.service.stop();
    } catch (error) {
      // A torn-down old core must not stop a new generation from starting.
      this.options.onWarn?.(`Could not stop the ${this.options.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
