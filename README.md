# Threads Orchestrator — Obsidian/Geode Plugin

Coordinate documents and Claude agents through a voice-first interface. Threads Orchestrator preserves the Voice conversation and document workflow while adding typed delegation through Claude Threads.

## Features

- **Live voice conversation** with your current document as context
- **Wake word detection** — say "hey obsidian" to connect hands-free, no button press needed. Runs a local ONNX model entirely on-device; no audio leaves your machine.
- **Voice enrollment** — record 5 samples to calibrate the wake word to your voice and microphone (Settings → Threads Orchestrator → Wake Word → Calibrate)
- **Silence auto-disconnect** — automatically disconnects after configurable silence (default 15s); wake word re-arms instantly so you can reconnect hands-free
- **Document tools** the AI can use mid-conversation:
  - Read the current document
  - Append timestamped notes
  - Insert text at cursor
  - Replace document content
  - Search your vault by keyword
  - Open any note in a new tab
  - List outgoing links
- **Claude Threads API v1 integration** — create, inspect, message, wait for, and open threads through Claude Threads' published API; discover and dispatch to Portfolio/Project orchestrators; receive semantic completion notifications
- **Orchestration (owned by this plugin)** — Agent Threads core no longer wakes orchestrators, runs a heartbeat, or ships the orchestrator skill; this plugin does all three and **requires an Agent Threads version with capabilities `orchestrators.ensure`, `orchestrators.setEnabled` and `extensions.registerSkill`** (there is no fallback; without them these features stay off and a warning is logged once per Agent Threads start). In particular, a new core with an old plugin means no wake-ups and no heartbeat (core removed its own), so ship them together. Settings → Orchestrators:
  - *Wake orchestrators on thread activity* (default on): when a thread finishes or fails, the Portfolio/Project orchestrator is pinged (batched, 12 s debounce). Off means the plugin sends no wake-ups.
  - *Orchestrator heartbeat* (default on, every 60 minutes, configurable 5-1440; stored values outside the range are clamped, so below 5 becomes 5; first fires one interval after load, not at startup): asks the Portfolio orchestrator and each enabled Project orchestrator to reconcile missed activity, queued if busy. It never creates an orchestrator that does not exist yet. This is a timer by design: it is the time-based backstop for missed events.
  - A list of orchestrators: open one (creating it if needed) and enable/disable Project orchestrators. The Portfolio orchestrator cannot be disabled.
  - The `thread-orchestrator` skill ships inside this plugin and is registered with Agent Threads on load (and removed on unload).
  - Known limits:
    - Wake-ups are sent with queueIfBusy. If Agent Threads still reports THREAD_BUSY, the batch is retried when the orchestrator next completes a run, at most 3 times, then dropped (the heartbeat is the backstop).
    - A batch still waiting out its 12 s debounce is discarded when the plugin unloads or the toggle is turned off; the heartbeat covers it.
    - A Project that was deleted (or is otherwise absent from the orchestrator list) after a failed dispatch gets one summary-only portfolio ping naming only the Project id.
- **Rich sidebar transcript** — see what was said, what tools ran, and what files were touched
- **Hotkey support** — bind a key to toggle the voice connection without touching the panel
- **Context banner** — always shows which file and how many chars the AI has as context

## Requirements

- A Claude Threads (Agent Threads) release that provides the orchestrator extraction API (`orchestrators.ensure`, `orchestrators.setEnabled`, `extensions.registerSkill`); this plugin version must be released together with it
- An [OpenAI API key](https://platform.openai.com/api-keys) with Realtime API access
- Obsidian 1.11.4 or later, or compatible desktop Geode (verified with Geode 0.22.7). Geode advertises Obsidian API compatibility level 1.10.2; this is not its app version. Required secret-storage APIs are checked at startup.
- Context files use inline suggestions in Obsidian and an “Add context file…” search modal in Geode.
- Agent Threads v0.33.0 or later for agent execution (document-only voice remains available when Threads is absent)

## Installation

Releases are available from the public [Threads Orchestrator repository](https://github.com/rbcodelabs/threads-orchestrator/releases).

In BRAT, add `rbcodelabs/threads-orchestrator`, then enable **Threads Orchestrator** in Community plugins. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same release into your vault's plugin directory under `threads-orchestrator`. Threads Orchestrator's plugin, view, and command IDs are distinct from legacy Voice and the previous Obsidian Orchestrator identity.

Wake-word assets download on first use. The inherited ONNX models currently come from the public `rbcodelabs/obsidian-voice` release, and the version-matched WASM runtime comes from jsDelivr. Network access to both is required unless the assets are already cached. The release also includes the ONNX models for manual installation. Audio recognition runs locally after those downloads.

Do not operate multiple voice controllers at once. If `obsidian-orchestrator` or legacy `obsidian-voice` is loaded, Threads Orchestrator pauses manual and wake-word microphone startup and shows a notice. Disable the previous plugin and reload Threads Orchestrator to resume its voice controls.

## Setup

1. Open Settings → Threads Orchestrator
2. Click **Set API Key** and paste your OpenAI API key
3. Choose a voice (Marin is the default)
4. Optionally add extra system prompt instructions
5. Click the mic icon in the ribbon (or use your hotkey) to open the Threads Orchestrator voice panel
6. Open a note, then click **Connect**

### Enabling wake word (optional)

1. In Settings → Threads Orchestrator → **Wake Word**, toggle on **Enable wake word**
2. Click **Calibrate** and say "hey obsidian" 5 times when prompted — this tunes detection to your voice and microphone
3. Open the Threads Orchestrator voice panel — it now listens passively and connects automatically when it hears "hey obsidian"

Without calibration the default threshold (0.75) works for many users; calibration gives better accuracy in noisy environments or if you're getting false triggers.

The wake-word runtime is bundled with the plugin. Geode desktop hosts exposing `geode.audioCaptureWorklet` use Geode's packaged PCM AudioWorklet, capturing audio off the renderer thread without permitting blob scripts. Other hosts retain the plugin's blob AudioWorklet; hosts that block it (including Geode 0.22.7), or cannot start the packaged worklet, use buffered Web Audio capture. The buffered fallback runs PCM capture on the renderer thread, so heavy UI activity can affect timing. All capture paths output silence to avoid microphone playback. This changes capture only, not the wake-word model or inference runtime. Calibration startup errors include their underlying cause; a model-loading failure does not necessarily mean microphone permission was denied.

## Usage

**Manual:** Click the mic icon in the ribbon (or use your hotkey) to open the Threads Orchestrator voice panel, then click **Connect**.

**Hands-free:** With wake word enabled, just say "hey obsidian" — the plugin connects and plays a short chime. After 15 seconds of silence (configurable) it disconnects automatically; say "hey obsidian" again to reconnect.

Once connected, just speak. The AI has your document in context and can answer questions or edit it on request. Tool actions appear as pills in the transcript so you can follow along.

The status bar shows real-time session activity:

| Status | Meaning |
|---|---|
| **Listening…** | Wake word detector is active, waiting for "hey obsidian" |
| **You're speaking…** | Server VAD has detected your voice |
| **AI responding…** | AI is generating and playing audio |
| **Silence — 12s** | No activity; countdown to auto-disconnect |
| **Connected** | Connected but idle (no VAD activity) |

To assign a hotkey: Settings → Hotkeys → search "Toggle Threads Orchestrator voice connection".

## Upgrading from Obsidian Orchestrator

Version 0.2.0 changes the plugin ID from `obsidian-orchestrator` to `threads-orchestrator`. GitHub redirects do not migrate plugin folders, enabled-plugin lists, BRAT or Geode updater records, saved workspace view IDs, or hotkeys.

1. Back up or retain the old `obsidian-orchestrator` plugin folder so its `data.json` remains available during import.
2. Disable **Obsidian Orchestrator**.
3. Remove `rbcodelabs/obsidian-orchestrator` from BRAT or the equivalent Geode community-plugin tracking entry.
4. Install `rbcodelabs/threads-orchestrator` and enable **Threads Orchestrator**.
5. Verify that your settings were imported and that the voice panel opens normally.
6. Rebind any custom hotkeys under the new Threads Orchestrator command names; hosts do not expose a supported hotkey-migration API.
7. Remove the old plugin folder only after the import and voice controls are verified.

If both plugin IDs are enabled, Threads Orchestrator pauses microphone and wake-word startup until the previous plugin is disabled. When the old plugin is disabled before Threads Orchestrator starts, a one-release bridge reopens a saved `obsidian-orchestrator:voice-panel` workspace leaf under the new view ID and detaches the legacy leaf.

## Migration from Voice 0.4.3

On its first load, Threads Orchestrator uses settings in this order: its own non-empty `data.json`, the previous `obsidian-orchestrator/data.json`, legacy `obsidian-voice/data.json`, then defaults. Voice choice, context files, prompts, auto-apply, wake-word configuration and enrollment, silence/grace timers, and debug preference are preserved. The shared `openai-api-key` SecretStorage entry is reused; a legacy plaintext key is moved there and never retained in Threads Orchestrator's data. Missing or malformed legacy data is ignored safely.

Say “Archive [thread name]” or “Mark [thread name] reviewed.” On hosts advertising `threads.archive` and `threads.markReviewed`, the host-owned voice bundle supplies `ct_archive_thread` and `ct_mark_reviewed`. Orchestrator resolves exact IDs from `ct_list_threads` and asks you to clarify ambiguous names. Mark reviewed works on idle threads, saves the reviewed flag, and leaves your active tab unchanged. Archive cancels pending wakeups and persists the archive before reporting success. Running threads and Portfolio/Project orchestrators require a host confirmation dialog; the last remaining thread cannot be archived. Cancellation is shown as “Archive cancelled,” never success. Conversation retention follows Agent Threads' existing storage settings.

These are trusted peer-plugin API operations; internal assistant Project-scoping rules are not a permission boundary for peer plugins. Ordinary actions follow an explicit user request, and exact tool results, target IDs, cancellation, and failure reasons remain visible in the voice transcript. Older hosts omit the new tools and retain their existing capabilities. Archived conversations are saved as vault notes only with `saveThreadsToVault` enabled; recovery is not promised when it is disabled. Internal assistant self-archive behavior is unchanged.

Compatibility changes in 0.1.0: `ct_close_thread` remains excluded, and `ct_get_active_thread` is removed because the current visible Threads view is not part of public API v1. Use explicit thread IDs from `ct_list_threads`. If Claude Threads unloads or reloads during a voice session, subscriptions detach and tool calls return clean unavailable/stale-generation errors. A new voice session picks up the replacement API generation and schemas.

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Voice | Marin | AI voice used for responses |
| Extra system prompt | — | Additional instructions appended to the base prompt |
| Wake orchestrators on thread activity | On | Send orchestrator wake-ups when threads finish or fail |
| Orchestrator heartbeat | On | Periodic reconcile ping to enabled orchestrators |
| Heartbeat interval (minutes) | 60 | 5-1440 |
| Enable wake word | Off | Listen for "hey obsidian" to auto-connect |
| Detection threshold | 0.75 | Confidence required to trigger (0–1). Lower = more sensitive. Calibrate sets this automatically. |
| Silence timeout | 15s | Seconds of silence before auto-disconnect (0 = disabled) |
| Debug logging | Off | Log wake word scores and session events to DevTools (Cmd+Option+I) |

## Model

Uses `gpt-realtime-2` via the OpenAI Realtime API (WebRTC).

## Debugging

`debug-realtime.mjs` is a Node.js probe script that connects directly to the OpenAI Realtime API via WebSocket and logs every event with timestamps, delta timings between events, and a session summary. Useful for understanding API event sequencing and timing without needing a full Obsidian reload cycle.

```bash
# Run from the repo root (reads OPENAI_API_KEY from env or .env file)
OPENAI_API_KEY=sk-... node debug-realtime.mjs
OPENAI_API_KEY=sk-... node debug-realtime.mjs "What is 2 + 2?"
```

Requires `ws` (already listed as a devDependency — run `npm install` first).

## Development

Run `npx tsc --noEmit`, `npm test`, and `npm run build` from the repository root. The build script resolves entry points and output relative to the current working directory. Version tags publish release assets through GitHub Actions.

For an installed-Geode calibration smoke test, build first, then run `scripts/test-geode-wake.mjs` with `GEODE_EXECUTABLE` pointing to the desktop binary and `PLAYWRIGHT_PACKAGE` pointing to a package.json whose installation provides `@playwright/test`. The test uses an isolated vault/profile, real ONNX models and synthetic microphone input; it does not test speech accuracy or access your actual microphone. It captures a screenshot in `docs/qa/`.

To verify packaged capture against a built Geode desktop checkout, run `GEODE_REPO=/path/to/geode node scripts/test-packaged-audio-worklet.mjs`. This launches an isolated profile, injects the actual capture implementation, and checks synthetic PCM delivery, repeated attachment on one AudioContext, and cleanup while rejecting blob creation, buffered fallback, and microphone access. It does not test wake-word recognition accuracy.

Version 0.1.0 delegates to the existing Portfolio/Project orchestrators in Agent Threads. Moving their policy, identity, and persistent state into this plugin remains a later phase.
