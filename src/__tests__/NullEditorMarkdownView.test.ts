/**
 * Regression: Geode can hand us a MarkdownView whose `file` is set but whose
 * `editor` is null (e.g. a view that is still loading or is in a non-editing
 * mode). Dereferencing `view.editor.getValue()` threw
 * "Cannot read properties of null (reading 'getValue')" from
 * VoiceView.onOpen and got the plugin disabled by the host's crash journal.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class { constructor(public leaf: unknown) {} },
  MarkdownView: class {},
  Notice: class {},
  TFile: class {},
  TFolder: class {},
  WorkspaceLeaf: class {},
  // Remaining runtime exports pulled in transitively by VoiceController.
  AbstractInputSuggest: class {},
  FuzzySuggestModal: class {},
  Modal: class {},
  Menu: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  SecretComponent: class {},
  Setting: class {},
  requestUrl: vi.fn(),
}));

import { executeToolCall } from '../DocumentTools';
import { VoiceController } from '../VoiceController';
import { VoiceView } from '../VoiceView';

const NO_DOC = '(no document currently open)';

function nullEditorView() {
  return { file: { name: 'note.md' }, editor: null } as never;
}

describe('MarkdownView with a file but a null editor', () => {
  it('VoiceView.updateContextBanner renders the file with 0 chars instead of throwing', () => {
    const spans: Array<{ cls: string; text: string }> = [];
    const banner = {
      empty: vi.fn(),
      createSpan: (opts: { cls: string; text: string }) => { spans.push(opts); },
    };
    const plugin = { controller: { lastMarkdownView: nullEditorView() } };
    const view = new VoiceView({} as never, plugin as never) as unknown as {
      contextBanner: unknown;
      updateContextBanner(): void;
    };
    view.contextBanner = banner;

    expect(() => view.updateContextBanner()).not.toThrow();
    expect(spans.map(s => s.text)).toEqual(['Context: ', 'note.md', ' · 0 chars']);
  });

  it('VoiceController.getCurrentDocContent reports no open document instead of throwing', () => {
    const controller = new VoiceController({ app: {} } as never);
    controller.lastMarkdownView = nullEditorView();

    const read = () => (controller as unknown as { getCurrentDocContent(): string }).getCurrentDocContent();
    expect(read).not.toThrow();
    expect(read()).toBe(NO_DOC);
  });

  it('DocumentTools.executeToolCall (getActiveEditor) returns a tool error instead of throwing', async () => {
    const result = await executeToolCall('get_document', {}, {} as never, nullEditorView());
    expect(result).toBe('Error: no document is currently open.');
  });

  it('still reads content when the editor is present', async () => {
    const editor = { getValue: () => 'hello' };
    const view = { file: { name: 'note.md' }, editor } as never;
    expect(await executeToolCall('get_document', {}, {} as never, view)).toBe('hello');
  });
});
