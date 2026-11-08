// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import { createTranslator } from 'next-intl';
import type { CheckpointMetadata } from '@/lib/vfs/checkpoint';

/**
 * Restoring from the panel names the checkpoint the way the panel shows it: an app-named
 * checkpoint by its label in the interface language, not by the stored English description.
 */

const checkpoints: CheckpointMetadata[] = [{
  id: 'cp1', projectId: 'p1', timestamp: new Date().toISOString(), kind: 'auto',
  description: 'Before import: stored english', label: { key: 'beforeImport', values: { name: 'site.zip' } },
}];
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { getCheckpoints: async () => checkpoints, pinCheckpoint: vi.fn(), unpinCheckpoint: vi.fn() },
  MAX_UNPINNED_PER_PROJECT: 5,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CheckpointPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useWorkspaceStore.setState({ workspaceReady: true } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CheckpointPanel restore', () => {
  it('passes the checkpoint\'s shown label to onRestore', async () => {
    const onRestore = vi.fn();
    await act(async () => {
      root.render(withMessages(<CheckpointPanel projectId="p1" events={[]} onRestore={onRestore} onScrollToTurn={() => {}} />));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain('Before import: site.zip');
    const restore = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!;
    await act(async () => { restore.click(); });
    expect(onRestore).toHaveBeenCalledWith('cp1', 'Before import: site.zip');
  });
});

describe('CheckpointPanel pin tooltip', () => {
  it('says how many newer checkpoints take an unpinned one away', async () => {
    // The tooltip places itself with a ResizeObserver, which jsdom does not have.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    checkpoints.push({ id: 'cp2', projectId: 'p1', timestamp: new Date().toISOString(), kind: 'manual', description: 'Kept', pinned: true });
    try {
      await act(async () => {
        root.render(withMessages(<CheckpointPanel projectId="p1" events={[]} onRestore={() => {}} onScrollToTurn={() => {}} />));
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      const unpin = [...container.querySelectorAll('button')].find((b) => b.textContent === en.workspace.unpin)!;
      await act(async () => { unpin.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
      // The message with the count the panel keeps (5, mocked above): without it the tooltip shows
      // the placeholder in a production build and the key path in this one.
      const t = createTranslator({ locale: 'en', messages: en });
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(t('checkpoints.tips.unpin', { count: 5 }));
    } finally {
      checkpoints.pop();
      vi.unstubAllGlobals();
    }
  });
});
