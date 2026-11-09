export type PublicErrorCode = 'PLUGIN_UNAVAILABLE' | 'THREAD_NOT_FOUND' | 'RUN_NOT_FOUND' | 'RUN_FAILED' | 'RUN_INTERRUPTED' | 'ORCHESTRATOR_NOT_FOUND' | 'THREAD_BUSY' | 'INVALID_ARGUMENT' | 'IDEMPOTENCY_CONFLICT' | 'TRACE_NOT_FOUND' | 'CURSOR_INVALID' | 'CONSTRAINT_UNSUPPORTED';
export type ThreadStatus = 'waiting' | 'active' | 'error' | 'archived' | 'reconnecting';
export interface PublicError { readonly code: PublicErrorCode; readonly message: string }
export interface MessageSnapshot { readonly id: string; readonly role: 'user' | 'assistant' | 'compact' | 'notice'; readonly content: string; readonly timestamp: number }
export interface ThreadSummary { readonly id: string; readonly title: string; readonly status: ThreadStatus; readonly reviewed: boolean; readonly cwd?: string; readonly projectId?: string; readonly agentHarness: 'claude' | 'codex'; readonly createdAt: number; readonly updatedAt: number; readonly isRunning: boolean; readonly messageCount: number }
export interface ThreadSnapshot extends ThreadSummary { readonly messages: readonly MessageSnapshot[] }
export interface ThreadQuery { readonly projectId?: string | null; readonly status?: ThreadStatus; readonly limit?: number }
export interface CreateThreadInput { readonly title?: string; readonly cwd?: string; readonly projectId?: string; readonly agentHarness?: 'claude' | 'codex' }
export interface SendInput { readonly prompt: string }
export interface WaitOptions { readonly timeoutMs?: number }
export type RunResult =
  | { readonly status: 'completed'; readonly runId: string; readonly threadId: string; readonly finalMessage?: MessageSnapshot }
  | { readonly status: 'failed'; readonly runId: string; readonly threadId: string; readonly error: PublicError }
  | { readonly status: 'timed_out'; readonly runId: string; readonly threadId: string };
export type PublicThreadEvent =
  | { readonly kind: 'run.started'; readonly threadId: string; readonly runId: string; readonly at: number }
  | { readonly kind: 'message.completed'; readonly threadId: string; readonly runId?: string; readonly message: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.completed'; readonly threadId: string; readonly runId: string; readonly finalMessage?: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.failed'; readonly threadId: string; readonly runId: string; readonly error: PublicError; readonly at: number }
  | { readonly kind: 'thread.removed'; readonly threadId: string; readonly at: number };
export interface Disposable { dispose(): void }
/** threadId is '' when the Project orchestrator is disabled or has no thread yet. */
export interface OrchestratorSnapshot { readonly id: string; readonly kind: 'portfolio' | 'project'; readonly threadId: string; readonly title: string; readonly projectId?: string; readonly enabled: boolean }
export interface DispatchInput extends SendInput { /** Queue the prompt if the orchestrator is busy instead of throwing THREAD_BUSY. */ readonly queueIfBusy?: boolean }
export const ORCHESTRATORS_ENSURE_CAPABILITY = 'orchestrators.ensure';
export const ORCHESTRATORS_SET_ENABLED_CAPABILITY = 'orchestrators.setEnabled';
export const EXTENSIONS_REGISTER_SKILL_CAPABILITY = 'extensions.registerSkill';
/**
 * Agent Threads capabilities this plugin cannot work without. There is deliberately no fallback for an older
 * Agent Threads: core and this plugin ship together, and the plugin's services stay off (with one warning) without them.
 */
export const REQUIRED_CORE_CAPABILITIES: readonly string[] = [ORCHESTRATORS_ENSURE_CAPABILITY, ORCHESTRATORS_SET_ENABLED_CAPABILITY, EXTENSIONS_REGISTER_SKILL_CAPABILITY];
export interface PeerIdentity { readonly pluginId: string }
export interface SkillContribution { readonly name: string; readonly description: string; /** SKILL.md body without frontmatter; core writes the frontmatter. */ readonly content: string }
export interface AgentToolDefinition { readonly type: 'function'; readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }
export interface AgentToolBundle { readonly tools: readonly AgentToolDefinition[]; execute(name: string, args: Record<string, unknown>): Promise<string> }
export interface ClaudeThreadsApiV1 {
  readonly apiVersion: 1; readonly generation: string; readonly capabilities: readonly string[];
  readonly threads: {
    archive?(threadId: string): Promise<{ readonly status: 'archived' | 'cancelled'; readonly threadId: string }>;
    markReviewed?(threadId: string): Promise<{ readonly threadId: string; readonly reviewed: true; readonly changed: boolean }>;
    list(query?: ThreadQuery): Promise<readonly ThreadSummary[]>; get(threadId: string): Promise<ThreadSnapshot | null>;
    create(input: CreateThreadInput): Promise<{ readonly threadId: string }>; send(threadId: string, input: SendInput): Promise<{ readonly runId: string }>;
    wait(runId: string, options?: WaitOptions): Promise<RunResult>; open(threadId: string): Promise<void>; subscribe(listener: (event: PublicThreadEvent) => void): Disposable;
  };
  readonly orchestrators: {
    list(): Promise<readonly OrchestratorSnapshot[]>; dispatch(target: { readonly id: string }, input: DispatchInput): Promise<{ readonly runId: string }>;
    /** Capability 'orchestrators.ensure'. id is 'portfolio' | 'project:<projectId>'. Idempotent create; re-enables a disabled Project. Does not open a view. */
    ensure(target: { readonly id: string }): Promise<OrchestratorSnapshot>;
    /** Capability 'orchestrators.setEnabled'. Project orchestrators only; the Portfolio cannot be disabled. Disabling keeps the thread. */
    setEnabled(target: { readonly id: string }, enabled: boolean): Promise<OrchestratorSnapshot>;
  };
  /** Capability 'extensions.registerSkill'. */
  readonly extensions: { registerSkill(owner: PeerIdentity, spec: SkillContribution): Disposable };
  readonly agentTools: { createBundle(profile: 'voice-orchestration'): AgentToolBundle };
}
