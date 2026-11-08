import { describe, it, expect } from 'vitest';
import { layoutFromLegacy, shapeOf, validateLayout } from '..';

const sizes = (L: ReturnType<typeof layoutFromLegacy>) => L.columns.map((c) => Math.round(c.size * 10) / 10);

describe('layoutFromLegacy', () => {
  it('opens a fresh workspace on chat, preview and files, evenly', () => {
    const L = layoutFromLegacy(null, null, null);
    expect(shapeOf(L)).toBe('chat>chat|preview>preview|files>files');
    expect(sizes(L)).toEqual([33.3, 33.3, 33.3]);
  });

  it('keeps the saved order and which panels were open, one column each', () => {
    const L = layoutFromLegacy(
      ['chat', 'files', 'editor', 'skills', 'console', 'preview', 'elements', 'checkpoints', 'debug'],
      { chat: true, files: false, editor: true, preview: true, checkpoints: false, debug: false, skills: false, console: false, elements: false },
      null,
    );
    expect(shapeOf(L)).toBe('chat>chat|editor>editor|preview>preview');
  });

  it('drops keys it does not know and appends panels an older order lacks', () => {
    const L = layoutFromLegacy(['preview', 'terminal', 'chat'], { files: true }, null);
    expect(shapeOf(L)).toBe('preview>preview|chat>chat|files>files');
  });

  it('carries over the widths react-resizable-panels saved for that set of panels', () => {
    const slots = {
      'panel-chat,panel-files,panel-preview': { expandToSizes: {}, layout: [25, 50, 25] },
      'panel-chat,panel-preview': { expandToSizes: {}, layout: [40, 60] },
    };
    expect(sizes(layoutFromLegacy(null, null, slots))).toEqual([25, 50, 25]);
  });

  it('ignores saved widths for a different set of panels or of the wrong length', () => {
    expect(sizes(layoutFromLegacy(null, null, { 'panel-chat,panel-preview': { layout: [40, 60] } }))).toEqual([33.3, 33.3, 33.3]);
    expect(sizes(layoutFromLegacy(null, null, { 'panel-chat,panel-files,panel-preview': { layout: [50, 50] } }))).toEqual([33.3, 33.3, 33.3]);
  });

  it('gives an empty workspace when every panel was closed', () => {
    const closed = Object.fromEntries(['chat', 'files', 'editor', 'preview', 'elements', 'skills', 'console', 'checkpoints', 'debug'].map((k) => [k, false]));
    expect(layoutFromLegacy(null, closed, null).columns).toEqual([]);
  });

  it('produces a layout validateLayout accepts unchanged', () => {
    const L = layoutFromLegacy(null, null, null);
    expect(validateLayout(L)).toEqual(L);
  });
});
