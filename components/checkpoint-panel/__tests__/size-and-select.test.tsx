// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { CheckpointMetadata } from '@/lib/vfs/checkpoint';

/**
 * Each row says how much changed since the checkpoint before it and how much space it takes; the
 * footer counts them; and Select deletes several at once, never the current save.
 */

const manager = vi.hoisted(() => ({
  list: [] as CheckpointMetadata[],
  base: null as { id: string; changes: { files: number; added: number; removed: number } } | null,
  deleteCheckpoint: vi.fn(async (_id: string) => true),
}));
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: {
    getCheckpoints: async () => manager.list,
    compareWithFiles: async () => manager.base,
    pinCheckpoint: vi.fn(async () => true),
    unpinCheckpoint: vi.fn(async () => true),
    renameCheckpoint: vi.fn(async () => true),
    deleteCheckpoint: manager.deleteCheckpoint,
  },
  unpinnedLimit: () => 10,
  savesLimit: () => 5,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CheckpointPanel } from '../index';
import { useWorkspaceStore } from '@/lib/stores/workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createTranslator({ locale: 'en', messages: en, namespace: 'checkpoints' });
const actions = createTranslator({ locale: 'en', messages: en, namespace: 'common.actions' });

let container: HTMLDivElement;
let root: Root;

const MB = 1024 * 1024;
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
const buttonNamed = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLElement | undefined;
const checkbox = (scope: HTMLElement) => scope.querySelector('button[role="checkbox"]') as HTMLButtonElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  manager.base = null;
  useWorkspaceStore.setState({ workspaceReady: true, checkpointRefreshKey: 0 } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('each row', () => {
  it('says what changed and how much space it takes', async () => {
    manager.list = [cp({ id: 'run', description: 'After: a run', size: 1.5 * MB, changes: { files: 3, added: 42, removed: 7 } })];
    await render();
    expect(row('After: a run').textContent).toContain(t('changes', { files: 3, added: 42, removed: 7 }));
    expect(row('After: a run').textContent).toContain('1.5 MB');
  });

  it('counts a changed image as a file, and a checkpoint with nothing new as no change', async () => {
    manager.list = [
      cp({ id: 'img', description: 'Image swap', size: 2048, changes: { files: 1, added: 0, removed: 0 } }),
      cp({ id: 'same', description: 'Same again', size: 2048, changes: { files: 0, added: 0, removed: 0 } }),
    ];
    await render();
    expect(row('Image swap').textContent).toContain(t('changedFiles', { files: 1 }));
    expect(row('Image swap').textContent).not.toContain('+0');
    expect(row('Same again').textContent).toContain(t('noChanges'));
  });

  it('shows no change line on a project\'s first checkpoint', async () => {
    manager.list = [cp({ id: 'first', description: 'Project opened', size: 512 })];
    await render();
    expect(row('Project opened').textContent).not.toContain(t('noChanges'));
  });
});

describe('the checkpoint the files came from', () => {
  const restoreIn = (scope: HTMLElement) => [...scope.querySelectorAll('button')].find((b) => b.textContent === en.workspace.restore);

  it('says Current in place of Restore while the files are the same', async () => {
    manager.list = [cp({ id: 'newer', description: 'Newer run' }), cp({ id: 'older', description: 'Older run', timestamp: at(5) })];
    manager.base = { id: 'newer', changes: { files: 0, added: 0, removed: 0 } };
    await render();

    expect(row('Newer run').textContent).toContain(t('current'));
    expect(restoreIn(row('Newer run'))).toBeUndefined();
    expect(restoreIn(row('Older run'))).toBeDefined();
    expect(row('Older run').textContent).not.toContain(t('current'));
  });

  it('keeps Restore and says what was edited once the files differ', async () => {
    manager.list = [cp({ id: 'newer', description: 'Newer run' })];
    manager.base = { id: 'newer', changes: { files: 2, added: 5, removed: 1 } };
    await render();

    expect(restoreIn(row('Newer run'))).toBeDefined();
    expect(row('Newer run').textContent).toContain(t('editedSince', { changes: t('changes', { files: 2, added: 5, removed: 1 }) }));
    expect(row('Newer run').textContent).not.toContain(t('current'));
  });

  it('compares again after a file changes', async () => {
    manager.list = [cp({ id: 'newer', description: 'Newer run' })];
    manager.base = { id: 'newer', changes: { files: 0, added: 0, removed: 0 } };
    await render();
    expect(restoreIn(row('Newer run'))).toBeUndefined();

    manager.base = { id: 'newer', changes: { files: 1, added: 1, removed: 0 } };
    await act(async () => {
      window.dispatchEvent(new Event('filesChanged'));
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(restoreIn(row('Newer run'))).toBeDefined();
  });
});

describe('the footer', () => {
  it('counts the checkpoints, the kept ones and the space they take', async () => {
    manager.list = [
      cp({ id: 'a', pinned: true, pinnedBy: 'user', size: 1 * MB }),
      cp({ id: 'b', size: 0.5 * MB }),
      cp({ id: 'c', size: 0.5 * MB }),
    ];
    await render();
    expect(container.textContent).toContain(t('summary', { count: 3, kept: 1, size: '2 MB' }));
  });
});

describe('selecting several', () => {
  const alertBar = () => container.querySelector('[role="alert"]') as HTMLElement | null;
  const confirmButton = () => [...(alertBar()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === actions('delete')) as HTMLElement;

  it('deletes the chosen checkpoints after one confirmation', async () => {
    manager.list = [cp({ id: 'one' }), cp({ id: 'two' }), cp({ id: 'three' })];
    await render();

    await act(async () => { buttonNamed(t('select'))!.click(); });
    await act(async () => { checkbox(row('one'))!.click(); });
    await act(async () => { checkbox(row('three'))!.click(); });
    expect(container.textContent).toContain(t('selected', { count: 2 }));
    await act(async () => { buttonNamed(actions('delete'))!.click(); });
    expect(manager.deleteCheckpoint).not.toHaveBeenCalled();
    expect(alertBar()!.textContent).toContain(t('deleteManyConfirm', { count: 2 }));

    await act(async () => { confirmButton().click(); });

    expect(manager.deleteCheckpoint.mock.calls.map((call) => call[0]).sort()).toEqual(['one', 'three']);
    expect(useWorkspaceStore.getState().checkpointRefreshKey).toBe(1);
    expect(toast.success).toHaveBeenCalledWith(t('deletedMany', { count: 2 }));
    // Back to the ordinary rows.
    expect(checkbox(row('two'))).toBeNull();
  });

  it('picks a row clicked anywhere, and again unpicks it', async () => {
    manager.list = [cp({ id: 'one' }), cp({ id: 'two' })];
    await render();

    await act(async () => { buttonNamed(t('select'))!.click(); });
    await act(async () => { row('two').click(); });
    expect(checkbox(row('two'))!.getAttribute('data-state')).toBe('checked');
    expect(checkbox(row('one'))!.getAttribute('data-state')).toBe('unchecked');
    await act(async () => { row('two').click(); });
    expect(checkbox(row('two'))!.getAttribute('data-state')).toBe('unchecked');
  });

  it('picks every unpinned checkpoint at once, never a pinned one or the current save', async () => {
    manager.list = [
      cp({ id: 'kept', pinned: true, pinnedBy: 'user' }),
      cp({ id: 'saved', kind: 'manual' }),
      cp({ id: 'run1' }),
      cp({ id: 'run2' }),
    ];
    await render('saved');

    await act(async () => { buttonNamed(t('select'))!.click(); });
    await act(async () => { buttonNamed(t('allUnpinned'))!.click(); });

    const picked = ['kept', 'saved', 'run1', 'run2'].filter((id) => checkbox(row(id))?.getAttribute('data-state') === 'checked');
    expect(picked).toEqual(['run1', 'run2']);
  });

  it('turns Select into Done, which leaves with nothing deleted', async () => {
    manager.list = [cp({ id: 'one' })];
    await render();

    await act(async () => { buttonNamed(t('select'))!.click(); });
    expect(buttonNamed(t('select'))).toBeUndefined();
    await act(async () => { row('one').click(); });
    await act(async () => { buttonNamed(actions('done'))!.click(); });

    expect(checkbox(row('one'))).toBeNull();
    expect(buttonNamed(t('select'))).toBeDefined();
    expect(manager.deleteCheckpoint).not.toHaveBeenCalled();
  });

  it('cannot select the current save', async () => {
    manager.list = [cp({ id: 'saved', kind: 'manual' }), cp({ id: 'other' })];
    await render('saved');

    await act(async () => { buttonNamed(t('select'))!.click(); });
    await act(async () => { row('saved').click(); });

    expect(checkbox(row('saved'))!.disabled).toBe(true);
    expect(checkbox(row('saved'))!.getAttribute('data-state')).toBe('unchecked');
    expect(container.textContent).toContain(t('selected', { count: 0 }));
    expect(checkbox(row('other'))!.disabled).toBe(false);
  });
});
