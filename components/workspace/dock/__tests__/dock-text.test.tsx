// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import type { WorkspaceLayout } from '@/lib/workspace-layout';
import { useDockText } from '../use-dock-text';

/**
 * The words a drag's preview and the panel menu give a drop and a refusal: which message, and which
 * panels it names. A cell is named by its front tab, or, in the group a tab is leaving, by the tab
 * that comes forward.
 */

const t = createTranslator({ locale: 'en', messages: en });
const titles = {
  chat: t('common.terms.chat'),
  preview: t('preview.livePreview'),
  files: t('workspace.tabs.fileExplorer'),
  skills: t('common.terms.skills'),
};

const layout: WorkspaceLayout = { v: 1, columns: [
  { id: 'col1', size: 34, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
  { id: 'col3', size: 33, cells: [{ id: 'cell4', size: 100, tabs: ['preview'], active: 'preview' }] },
  { id: 'col5', size: 33, cells: [{ id: 'cell6', size: 100, tabs: ['files', 'skills'], active: 'files' }] },
] };

let text: ReturnType<typeof useDockText>;
function Probe() {
  text = useDockText();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(withMessages(<Probe />)));
});

afterAll(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useDockText', () => {
  it('words each refusal, with the panel that is too short', () => {
    expect(text.refusal({ code: 'width', px: 240 })).toBe(t('workspace.layout.refusal.width', { px: 240 }));
    expect(text.refusal({ code: 'height', panel: 'chat', px: 420 })).toBe(t('workspace.layout.refusal.height', { panel: titles.chat, px: 420 }));
    expect(text.refusal({ code: 'inspector-preview' })).toBe(t('workspace.layout.refusal.inspectorPreview'));
  });

  it('calls a tab drop on another cell a tab in it, and one on its own strip a reorder', () => {
    expect(text.target(layout, { kind: 'tab', cell: 'cell4', index: null }, { panel: 'chat' })).toBe(t('workspace.layout.target.tabIn', { panel: titles.preview }));
    expect(text.target(layout, { kind: 'tab', cell: 'cell6', index: 0 }, { panel: 'skills' })).toBe(t('workspace.layout.target.reorder'));
  });

  it('names a stack by the cell\'s front tab, or by the tab that comes forward in the group a tab leaves', () => {
    expect(text.target(layout, { kind: 'stack', cell: 'cell4', side: 'above' }, { panel: 'chat' })).toBe(t('workspace.layout.target.above', { panel: titles.preview }));
    expect(text.target(layout, { kind: 'stack', cell: 'cell6', side: 'below' }, { panel: 'files' }, { cell: 'cell6', panel: 'skills' }))
      .toBe(t('workspace.layout.target.below', { panel: titles.skills }));
  });

  it('places a new column between, left of or right of the columns around it', () => {
    expect(text.target(layout, { kind: 'column', before: 'col3' }, { panel: 'files' })).toBe(t('workspace.layout.target.columnBetween', { left: titles.chat, right: titles.preview }));
    expect(text.target(layout, { kind: 'column', before: 'col1' }, { panel: 'files' })).toBe(t('workspace.layout.target.columnLeftOf', { panel: titles.chat }));
    expect(text.target(layout, { kind: 'column', before: null }, { panel: 'chat' })).toBe(t('workspace.layout.target.columnRightOf', { panel: titles.files }));
    expect(text.target({ v: 1, columns: [] }, { kind: 'column', before: null }, { panel: 'chat' })).toBe(t('workspace.layout.target.column'));
  });
});
