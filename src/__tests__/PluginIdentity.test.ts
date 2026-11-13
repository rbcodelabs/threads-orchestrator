import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Threads Orchestrator package identity', () => {
  it('uses a non-colliding plugin ID and consistent release metadata', () => {
    const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const versions = JSON.parse(readFileSync(resolve('versions.json'), 'utf8'));
    expect(manifest).toMatchObject({ id: 'threads-orchestrator', name: 'Threads Orchestrator', version: '0.3.3' });
    expect(manifest.description.toLowerCase()).toContain('voice');
    expect(pkg).toMatchObject({ name: 'threads-orchestrator', version: manifest.version });
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    expect(versions['0.1.0']).toBe('1.11.4');
  });

  it('registers non-colliding view and command IDs', () => {
    const main = readFileSync(resolve('src/main.ts'), 'utf8');
    const identity = readFileSync(resolve('src/PluginIdentity.ts'), 'utf8');
    expect(main).toContain("id: 'open-threads-orchestrator-panel'");
    expect(main).toContain("id: 'toggle-threads-orchestrator-voice'");
    expect(main).toContain("id: 'toggle-threads-orchestrator-wake-word'");
    expect(main).toContain('installLegacyViewBridge(');
    expect(main).not.toContain('this.registerView(LEGACY_ORCHESTRATOR_VOICE_VIEW_TYPE');
    expect(main).toContain('if (this.legacyViewBridgeRegistered)');
    expect(identity).toContain("'threads-orchestrator:voice-panel'");
    expect(identity).toContain("'obsidian-orchestrator:voice-panel'");
  });

  it('keeps the established wake phrase, model, and secret contract', () => {
    const settings = readFileSync(resolve('src/settings.ts'), 'utf8');
    expect(settings).toContain("OPENAI_SECRET_ID = 'openai-api-key'");
    expect(settings).toContain("wakeWord: 'hey obsidian'");
    expect(readFileSync(resolve('models/hey_obsidian.onnx')).byteLength).toBeGreaterThan(10_000);
  });
});
