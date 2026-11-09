import { Menu, Notice, Plugin, SecretComponent, WorkspaceLeaf } from 'obsidian';
import { LegacyVoiceView, VoiceView, THREADS_ORCHESTRATOR_VOICE_VIEW_TYPE } from './VoiceView';
import { VoiceController } from './VoiceController';
import { VoiceSettings, DEFAULT_SETTINGS, ThreadsOrchestratorSettingTab, OPENAI_SECRET_ID } from './settings';
import type { SessionStatus } from './RealtimeSession';
import { ClaudeThreadsApiClient } from './ClaudeThreadsApiClient';
import { isConflictingVoicePluginActive } from './Coexistence';
import { migrateLegacyVoiceSettings, selectSettingsSource } from './SettingsMigration';
import { assertHostCompatibility } from './HostCompatibility';
import { migrateLegacyVoiceView } from './LegacyViewMigration';
import { LEGACY_ORCHESTRATOR_VOICE_VIEW_TYPE } from './PluginIdentity';
import { installLegacyViewBridge } from './LegacyViewBridge';
import { siblingPluginDataPath } from './PluginDataPath';
import { readAdapterText } from './PluginDataReader';
import { ServiceLifecycle } from './ServiceLifecycle';
import { WakeupService } from './WakeupService';
import { HeartbeatService, heartbeatIntervalMs } from './HeartbeatService';
import { SkillService } from './SkillService';
import { runAllSafely } from './SafeTeardown';

export default class ThreadsOrchestratorPlugin extends Plugin {
  settings!: VoiceSettings;
  controller!: VoiceController;
  threadsApi!: ClaudeThreadsApiClient;
  wakeDetectorSuspended = false;
  private legacyViewBridgeRegistered = false;
  private wakeupLifecycle: ServiceLifecycle | null = null;
  private heartbeatLifecycle: ServiceLifecycle | null = null;
  private skillLifecycle: ServiceLifecycle | null = null;

  // Status bar UI elements
  private statusBarItem!: HTMLElement;
  private statusBarDot!: HTMLElement;
  private statusBarText!: HTMLElement;

  async onload() {
    assertHostCompatibility(this.app, SecretComponent);
    await this.loadSettings();

    this.threadsApi = new ClaudeThreadsApiClient(this.app as never);
    this.threadsApi.start();

    // Create the plugin-level controller (independent of any pane).
    this.controller = new VoiceController(this);
    const unsubscribeThreadsApi = this.threadsApi.onChange(api => {
      if (!api) this.controller.handleThreadsUnavailable();
    });
    this.register(unsubscribeThreadsApi);

    // Orchestration now lives in this plugin. Each service runs against the current
    // Agent Threads API generation and requires the new core capabilities (no fallback).
    const warnOnce = { generation: null as string | null };
    const warn = (message: string) => console.warn(`[Threads Orchestrator] ${message}`);
    this.wakeupLifecycle = new ServiceLifecycle({
      client: this.threadsApi, label: 'orchestrator wake-up service', onWarn: warn, warnOnce,
      isEnabled: () => this.settings.wakeOrchestratorsOnActivity !== false,
      createService: api => new WakeupService(api, { onWarn: warn, onError: error => console.error('[Threads Orchestrator] Orchestrator wake-up failed:', error) }),
    });
    this.heartbeatLifecycle = new ServiceLifecycle({
      client: this.threadsApi, label: 'orchestrator heartbeat', onWarn: warn, warnOnce,
      isEnabled: () => this.settings.heartbeatEnabled !== false,
      createService: api => new HeartbeatService(api, {
        intervalMs: heartbeatIntervalMs(this.settings.heartbeatIntervalMinutes), onWarn: warn,
        onError: error => console.error('[Threads Orchestrator] Orchestrator heartbeat failed:', error),
      }),
    });
    this.skillLifecycle = new ServiceLifecycle({
      client: this.threadsApi, label: 'thread-orchestrator skill registration', onWarn: warn, warnOnce,
      isEnabled: () => true,
      createService: api => new SkillService(api, { pluginId: this.manifest.id }),
    });
    this.skillLifecycle.start();
    this.wakeupLifecycle.start();
    this.heartbeatLifecycle.start();
    // Idempotent safety net: services must stop even if a later unload step throws.
    this.register(() => this.disposeOrchestration());
    this.controller.startTrackingActiveFile();

    // Start wake word detector once the workspace is fully ready.
    this.app.workspace.onLayoutReady(() => {
      if (this.hasVoicePluginConflict()) {
        new Notice('Threads Orchestrator voice controls are paused because a previous voice plugin is active. Disable Obsidian Orchestrator and Voice, then reload Threads Orchestrator.');
      } else {
        this.controller.syncWakeWordDetector();
      }
    });

    // Register the pane view.
    this.registerView(THREADS_ORCHESTRATOR_VOICE_VIEW_TYPE, (leaf) => new VoiceView(leaf, this));
    this.legacyViewBridgeRegistered = installLegacyViewBridge(
      this.app as never,
      (type) => {
        this.registerView(type, (leaf) => new LegacyVoiceView(leaf, this));
      },
      () => migrateLegacyVoiceView(this.app.workspace),
    );

    // Ribbon icon — opens the transcript pane.
    this.addRibbonIcon('mic', 'Threads Orchestrator — open voice panel', () => this.activateView());

    // Status bar item — shows live status and opens a menu on click.
    // Exact structure from v0.4.0 — a span dot + span text inside a flex
    // container. Don't reinvent this.
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('voice-statusbar-item');
    this.statusBarItem.setAttribute('aria-label', 'Threads Orchestrator voice: click to connect / disconnect');
    this.statusBarItem.setAttribute('title', 'Threads Orchestrator voice: click to connect / disconnect');

    // Use the Unicode "●" (U+25CF BLACK CIRCLE) as the dot — it has intrinsic
    // glyph size from the font, so no width/height CSS is needed. Empty spans
    // collapse to 0x0 the moment any rule overrides display:inline-block.
    // Spacing is set as INLINE STYLE so it beats any theme/Obsidian CSS — the
    // external stylesheet's margin keeps getting overridden by something in
    // the cascade that we don't control.
    this.statusBarDot  = this.statusBarItem.createSpan({ cls: 'voice-statusbar-dot voice-statusbar-dot--idle', text: '●' });
    this.statusBarDot.style.marginRight = '8px';
    this.statusBarDot.style.fontSize = '1.15em';
    this.statusBarDot.style.lineHeight = '1';
    this.statusBarText = this.statusBarItem.createSpan({ cls: 'voice-statusbar-text', text: 'Threads Orchestrator' });
    this.statusBarText.style.marginLeft = '0';

    this.statusBarItem.addEventListener('click', (evt) => this.showStatusBarMenu(evt));

    // Keep the status bar in sync with controller events. Subscribe to both
    // status (idle/connecting/connected/error) AND activity (the live state
    // machine label inside a 'connected' session, e.g. "Silence — 12s").
    this.controller.onStatusChange((status) => this.updateStatusBar(status));
    this.controller.onActivityChange(() => this.updateStatusBar(this.controller.currentStatus));

    // Paint once with current intent so the bar reflects "Listening…" even
    // before the wake detector finishes loading models (it can take a beat
    // after onLayoutReady, and the user shouldn't see a stale "Voice" label).
    this.updateStatusBar(this.controller.currentStatus);

    // Commands
    this.addCommand({
      id: 'open-threads-orchestrator-panel',
      name: 'Open Threads Orchestrator voice panel',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'toggle-threads-orchestrator-voice',
      name: 'Toggle Threads Orchestrator voice connection',
      callback: () => this.controller.toggleConnection(),
    });

    this.addCommand({
      id: 'toggle-threads-orchestrator-wake-word',
      name: 'Toggle wake word listening',
      callback: () => this.toggleWakeWord(),
    });

    this.addSettingTab(new ThreadsOrchestratorSettingTab(this.app, this));

    // Only the focused vault window should listen for wake words.
    // Each vault is its own Electron BrowserWindow; focus/blur fire when the
    // user switches between them. registerDomEvent auto-removes on unload.
    this.registerDomEvent(window, 'blur',  () => this.suspendWakeDetector());
    this.registerDomEvent(window, 'focus', () => this.resumeWakeDetector());
    // If this vault window isn't currently focused (e.g. opened in background
    // by BRAT), start with the detector already suspended.
    if (!document.hasFocus()) this.wakeDetectorSuspended = true;
  }

  async onunload() {
    // Orchestration services first: the skill registration and timers must not outlive the plugin.
    runAllSafely([
      () => this.disposeOrchestration(),
      () => this.controller.destroy(),
      () => this.threadsApi.dispose(),
      // Detach all Voice panel leaves on unload so Obsidian doesn't keep a
      // stale VoiceView instance alive across plugin reloads or BRAT updates.
      () => this.app.workspace.detachLeavesOfType(THREADS_ORCHESTRATOR_VOICE_VIEW_TYPE),
      () => { if (this.legacyViewBridgeRegistered) this.app.workspace.detachLeavesOfType(LEGACY_ORCHESTRATOR_VOICE_VIEW_TYPE); },
    ], error => console.error('[Threads Orchestrator] unload step failed:', error));
  }

  /** Called from the settings tab whenever wakeWordEnabled or wakeWord changes. */
  applyWakeWordSetting(): void {
    this.controller.syncWakeWordDetector();
  }

  /** Called from the settings tab when wakeOrchestratorsOnActivity changes. */
  applyWakeupSetting(): void {
    this.wakeupLifecycle?.sync();
  }

  /** Called from the settings tab when the heartbeat toggle or interval changes. */
  applyHeartbeatSetting(): void {
    this.heartbeatLifecycle?.restart();
  }

  private disposeOrchestration(): void {
    runAllSafely([
      () => { this.heartbeatLifecycle?.dispose(); this.heartbeatLifecycle = null; },
      () => { this.wakeupLifecycle?.dispose(); this.wakeupLifecycle = null; },
      () => { this.skillLifecycle?.dispose(); this.skillLifecycle = null; },
    ], error => console.error('[Threads Orchestrator] orchestration teardown failed:', error));
  }

  suspendWakeDetector(): void {
    this.wakeDetectorSuspended = true;
    this.controller.stopWakeDetector();
    this.updateStatusBar(this.controller.currentStatus);
  }

  resumeWakeDetector(): void {
    this.wakeDetectorSuspended = false;
    this.controller.activateWakeDetector();
    this.updateStatusBar(this.controller.currentStatus);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(THREADS_ORCHESTRATOR_VOICE_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: THREADS_ORCHESTRATOR_VOICE_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData() as Record<string, unknown> | null;
    const readPluginData = async (pluginId: string): Promise<string | null> => {
      const path = siblingPluginDataPath(pluginId, {
        manifestDir: this.manifest.dir,
        configDir: (this.app.vault as typeof this.app.vault & { configDir?: string }).configDir,
      });
      if (!path) return null;
      return readAdapterText(this.app.vault.adapter, path);
    };
    const selected = await selectSettingsSource(data, {
      readPreviousOrchestrator: () => readPluginData('obsidian-orchestrator'),
      readLegacyVoice: () => readPluginData('obsidian-voice'),
    });
    const migrated = await migrateLegacyVoiceSettings(
      selected.source === 'legacy-voice' ? {} : selected.data,
      {
        readLegacy: async () => selected.source === 'legacy-voice' ? JSON.stringify(selected.data) : null,
        setSecret: (id, value) => this.app.secretStorage.setSecret(id, value),
      },
    );
    await this.saveData(migrated.settings);

    // Clean up any garbage written by SecretComponent (stores key name, not value).
    const storedKey = this.app.secretStorage.getSecret(OPENAI_SECRET_ID);
    if (storedKey && !storedKey.startsWith('sk-')) {
      this.app.secretStorage.setSecret(OPENAI_SECRET_ID, '');
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated.settings) as VoiceSettings;
  }

  hasVoicePluginConflict(): boolean {
    return isConflictingVoicePluginActive(this.app as never);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Status bar menu ──────────────────────────────────────────────────────

  private showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const connected = this.controller.isConnected;

    menu.addItem((item) =>
      item
        .setTitle(connected ? 'Disconnect' : 'Connect')
        .setIcon(connected ? 'mic-off' : 'mic')
        .onClick(() => this.controller.toggleConnection()),
    );

    menu.addSeparator();

    const wakeEnabled = this.settings.wakeWordEnabled;
    menu.addItem((item) =>
      item
        .setTitle(wakeEnabled ? 'Disable wake word' : 'Enable wake word')
        .setIcon(wakeEnabled ? 'volume-x' : 'volume-2')
        .onClick(() => this.toggleWakeWord()),
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('Open Threads Orchestrator voice panel')
        .setIcon('layout-panel-right')
        // Defer to the next tick so the Menu finishes closing before we
        // mutate the workspace — otherwise the leaf creation can race the
        // menu teardown and silently swallow the click.
        .onClick(() => {
          setTimeout(() => {
            this.activateView().catch((err) => {
              console.error('[Threads Orchestrator] activateView failed:', err);
              new Notice('Threads Orchestrator: failed to open voice panel — check the console.');
            });
          }, 0);
        }),
    );

    menu.showAtMouseEvent(evt);
  }

  private async toggleWakeWord(): Promise<void> {
    this.settings.wakeWordEnabled = !this.settings.wakeWordEnabled;
    await this.saveSettings();
    this.controller.syncWakeWordDetector();
    this.updateStatusBar(this.controller.currentStatus);
  }

  // ── Status bar rendering ─────────────────────────────────────────────────

  private updateStatusBar(status: SessionStatus): void {
    const ctrl = this.controller;
    const activity = ctrl.getActivityInfo();
    // "Listening…" reflects USER INTENT, not detector internals. The detector
    // takes a few hundred ms to load ONNX models after onLayoutReady, and is
    // also briefly null between focus/blur transitions — but during all of
    // that the user still expects to see "Listening…" because that's what
    // they configured. Only fall back to "Voice" when the wake word is truly
    // off or the window is unfocused (and therefore actually paused).
    const isListening =
      !ctrl.isConnected &&
      this.settings.wakeWordEnabled &&
      !this.wakeDetectorSuspended;

    // Connected: surface the live state-machine label so the user can see what
    // the session is doing without opening the panel.
    const connectedLabel = (): string => {
      switch (activity.activity) {
        case 'user-speaking':       return 'You\'re speaking';
        case 'ai-responding':       return 'AI responding';
        case 'tool-running':        return 'AI working';
        case 'silence':             return `Silence — ${activity.silenceSecsLeft ?? 0}s`;
        case 'disconnect-pending':  return `Disconnect in ${activity.disconnectPendingSecsLeft ?? 0}s`;
        case 'listening':           return 'Threads Orchestrator · connected';
        default:                    return 'Threads Orchestrator · connected';
      }
    };
    const connectedDot = (): string => {
      switch (activity.activity) {
        case 'user-speaking':       return 'listening';
        case 'ai-responding':       return 'connecting';
        case 'tool-running':        return 'connecting';
        case 'disconnect-pending':  return 'error';
        default:                    return 'connected';
      }
    };

    const labels: Record<SessionStatus, string> = {
      idle:       isListening ? 'Listening…' : 'Threads Orchestrator',
      connecting: 'Connecting…',
      connected:  ctrl.isConnected ? connectedLabel() : 'Threads Orchestrator',
      error:      'Threads Orchestrator',
    };

    const dotMods: Record<SessionStatus, string> = {
      idle:       isListening ? 'listening' : 'idle',
      connecting: 'connecting',
      connected:  ctrl.isConnected ? connectedDot() : 'idle',
      error:      'error',
    };

    if (this.statusBarText) this.statusBarText.textContent = labels[status];

    if (this.statusBarDot) {
      const mod = dotMods[status];
      // Keep the class for theme overrides, but ALSO set color inline so we
      // beat any cascade rules that have been overriding our stylesheet.
      for (const m of ['idle', 'listening', 'connecting', 'connected', 'error']) {
        this.statusBarDot.removeClass(`voice-statusbar-dot--${m}`);
      }
      this.statusBarDot.addClass(`voice-statusbar-dot--${mod}`);

      const colors: Record<string, string> = {
        idle:       '#888888',  // gray
        listening:  '#4287f5',  // blue
        connecting: '#d4a017',  // amber
        connected:  '#2da44e',  // green
        error:      '#cf222e',  // red
      };
      this.statusBarDot.style.color = colors[mod] ?? colors.idle;

      // Pulse animation for live states (listening / connecting).
      const shouldPulse = mod === 'listening' || mod === 'connecting';
      this.statusBarDot.style.animation = shouldPulse
        ? 'voice-pulse 1.5s ease-in-out infinite'
        : '';
    }
  }
}
