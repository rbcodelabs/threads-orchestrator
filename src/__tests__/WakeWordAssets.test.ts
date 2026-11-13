import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_RELEASE_BASE_URL } from '../WakeWordAssets';

describe('wake-word model download source', () => {
  it("downloads ONNX models from this repository's latest release", () => {
    expect(MODEL_RELEASE_BASE_URL).toBe(
      'https://github.com/rbcodelabs/threads-orchestrator/releases/latest/download',
    );
  });

  it('WakeWordDetector uses the shared base URL and no hardcoded legacy repo', () => {
    const source = readFileSync(resolve('src/WakeWordDetector.ts'), 'utf8');
    expect(source).toContain('MODEL_RELEASE_BASE_URL');
    expect(source).not.toContain('rbcodelabs/obsidian-voice');
  });
});
