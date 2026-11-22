// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { CheckpointMetadata } from '@/lib/vfs/checkpoint';

/**
 * What each checkpoint row offers. Save pins each save until the next one, so the current save
 * offers Keep rather than Unpin; a checkpoint can be named and deleted from its menu, except the
 * current save, which Discard Changes goes back to.
 */

const manager = vi.hoisted(() => ({
  list: [] as CheckpointMetadata[],
  pinCheckpoint: vi.fn(async () => true),
  unpinCheckpoint: vi.fn(async () => true),
  renameCheckpoint: vi.fn(async () => true),
  deleteCheckpoint: vi.fn(async () => true),
}));
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: {
    getCheckpoints: async () => manager.list,
    compareWithFiles: async () => null,
    pinCheckpoint: manager.pinCheckpoint,
    unpinCheckpoint: manager.unpinCheckpoint,
    renameCheckpoint: manager.renameCheckpoint,
    deleteCheckpoint: manager.deleteCheckpoint,
  },
  unpinnedLimit: () => 7,
  savesLimit: () => 4,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CheckpointPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createTranslator({ locale: 'en', messages: en });

let container: HTMLDivElement;
let root: Root;

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const cp = (over: Partial<CheckpointMetadata> & { id: string }): CheckpointMetadata => ({
  projectId: 'p1', timestamp: at(1), kind: 'auto', description: over.id, ...over,
});

async function render(savedCheckpointId: string | null = null) {
  await act(async () => {
    root.render(withMessages(
      <CheckpointPanel projectId="p1" events={[]} savedCheckpointId={savedCheckpointId} onRestore={() => {}} onScrollToTurn={() => {}} />
    ));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const row = (text: string) => [...container.querySelectorAll('div.rounded-md')].find((r) => r.textContent?.includes(text)) as HTMLElement;
const button = (scope: HTMLElement, label: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label);

async function openMenu(scope: HTMLElement) {
  const trigger = scope.querySelector(`button[aria-label="${t('checkpoints.more')}"]`) as HTMLElement;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ workspaceReady: true } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the pin control', () => {
  it('locks the latest save: kept as pinned, at the top, with no pin to take off', async () => {
    manager.list = [
      cp({ id: 'cp_run', description: 'Newer run' }),
      cp({ id: 'cp_save', kind: 'manual', description: 'Manual save', timestamp: at(30) }),
    ];
    await render('cp_save');

    const saveRow = row('Manual save');
    expect(saveRow.querySelector(`[role="img"][aria-label="${t('checkpoints.latestSave')}"]`)).not.toBeNull();
    expect(button(saveRow, t('workspace.pin'))).toBeUndefined();
    expect(button(saveRow, t('workspace.unpin'))).toBeUndefined();
    expect(saveRow.className).toContain('border-amber-500/30');
    expect([...container.querySelectorAll('div.rounded-md')][0]).toBe(saveRow);
  });

  it('locks the opening checkpoint before the first save without calling it a save', async () => {
    manager.list = [cp({ id: 'cp_open', kind: 'auto', description: 'Project opened' })];
    await render('cp_open');

    const opened = row('Project opened');
    expect(opened.querySelector(`[role="img"][aria-label="${t('checkpoints.startPoint')}"]`)).not.toBeNull();
    expect(opened.querySelector(`[aria-label="${t('checkpoints.latestSave')}"]`)).toBeNull();
    expect(opened.textContent).toContain(t('checkpoints.kindAuto'));
    expect(opened.textContent).not.toContain(t('checkpoints.kindManual'));
    expect(button(opened, t('workspace.pin'))).toBeUndefined();
  });

  it('offers Pin on an earlier save, counted against the saves kept', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    manager.list = [cp({ id: 'cp_old', kind: 'manual', description: 'Older save' })];
    try {
      await render('cp_save');
      const pin = button(row('Older save'), t('workspace.pin'))!;
      await act(async () => { pin.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(t('checkpoints.tips.pinSave', { count: 4 }));
      await act(async () => { pin.click(); });
      expect(manager.pinCheckpoint).toHaveBeenCalledWith('cp_old');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers Unpin on a checkpoint the person pinned', async () => {
    manager.list = [cp({ id: 'cp_kept', pinned: true, pinnedBy: 'user', description: 'v1.0' })];
    await render('cp_other');

    await act(async () => { button(row('v1.0'), t('workspace.unpin'))!.click(); });
    expect(manager.unpinCheckpoint).toHaveBeenCalledWith('cp_kept');
  });

  it('locks the current save whatever pin it carries, and reads any other pin as the person\'s', async () => {
    manager.list = [
      cp({ id: 'cp_current', kind: 'manual', pinned: true, description: 'Current save' }),
      cp({ id: 'cp_older', pinned: true, description: 'Pinned long ago', timestamp: at(60) }),
    ];
    await render('cp_current');

    expect(button(row('Current save'), t('workspace.pin'))).toBeUndefined();
    expect(button(row('Current save'), t('workspace.unpin'))).toBeUndefined();
    expect(row('Current save').textContent).not.toContain(t('checkpoints.pinned'));
    expect(button(row('Pinned long ago'), t('workspace.unpin'))).toBeDefined();
  });
});

describe('the row menu', () => {
  it('names a checkpoint with what is typed', async () => {
    manager.list = [cp({ id: 'cp1', label: { key: 'preGeneration' } })];
    await render();

    const [rename] = await openMenu(row(t('checkpoints.preGeneration')));
    await act(async () => { rename.click(); });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'v1.0 Stable Release');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

    expect(manager.renameCheckpoint).toHaveBeenCalledWith('cp1', 'v1.0 Stable Release');
  });

  it('deletes only after the row\'s confirmation', async () => {
    manager.list = [cp({ id: 'cp1', description: 'Old run' })];
    await render('cp_save');

    const [, del] = await openMenu(row('Old run'));
    await act(async () => { del.click(); });
    expect(manager.deleteCheckpoint).not.toHaveBeenCalled();
    expect(container.textContent).toContain(t('checkpoints.deleteConfirm'));

    await act(async () => { button(row('Old run'), t('common.actions.delete'))!.click(); });
    expect(manager.deleteCheckpoint).toHaveBeenCalledWith('cp1');
  });

  it('does not offer to delete the current save', async () => {
    manager.list = [cp({ id: 'cp_save', kind: 'manual', description: 'Manual save' })];
    await render('cp_save');

    const [, del] = await openMenu(row('Manual save'));
    expect(del.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { del.click(); });
    expect(container.textContent).not.toContain(t('checkpoints.deleteConfirm'));
  });
});
