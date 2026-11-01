// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Gallery edits hand the manager only the fields they change, so a copy of the project loaded
 * before another tab saved cannot overwrite that save; a thumbnail that could not be stored says so.
 * The table row's menu names the export each item runs.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/vfs', () => ({ vfs: { getProjectStats: vi.fn(async () => null) } }));
vi.mock('@/lib/hooks/use-project-sync-state', () => ({ useProjectSyncState: () => ({ statuses: new Map() }) }));
vi.mock('@/lib/utils/project-thumbnail', () => ({ captureProjectScreenshot: vi.fn() }));
// The thumbnail area stands in for an upload: one click hands the component a new image.
vi.mock('@/components/ui/thumbnail-area', () => ({
  ThumbnailArea: ({ onImageChange }: { onImageChange: (image: string | undefined) => void }) => (
    <button data-upload onClick={() => onImageChange('data:image/png;base64,x')} />
  ),
}));

import { ProjectCard } from '../project-card';
import { ProjectTableRow } from '../project-table-row';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { Project } from '@/lib/vfs/types';

const PROJECT: Project = { id: 'p1', name: 'Site', createdAt: new Date(0), updatedAt: new Date(0) } as Project;
const noop = () => {};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(element: React.ReactElement) {
  await act(async () => { root.render(withMessages(element)); });
}

async function uploadWith(element: React.ReactElement) {
  await render(element);
  const upload = container.querySelector<HTMLButtonElement>('[data-upload]');
  expect(upload).not.toBeNull();
  await act(async () => { upload!.click(); });
}

const handlers = {
  onSelect: noop, onDelete: noop, onExport: noop, onExportZip: noop, onDuplicate: noop, onPreview: noop,
};

const THUMBNAIL_CHANGE = { previewImage: 'data:image/png;base64,x', previewUpdatedAt: expect.any(Date) };

describe('a thumbnail upload', () => {
  it('passes only the thumbnail from the grid card', async () => {
    const onUpdate = vi.fn(async () => {});
    await uploadWith(<ProjectCard project={PROJECT} {...handlers} onUpdate={onUpdate} />);
    expect(onUpdate).toHaveBeenCalledWith('p1', THUMBNAIL_CHANGE);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('passes only the thumbnail from the table row', async () => {
    const onUpdate = vi.fn(async () => {});
    await uploadWith(<table><tbody><ProjectTableRow project={PROJECT} {...handlers} onUpdate={onUpdate} /></tbody></table>);
    expect(onUpdate).toHaveBeenCalledWith('p1', THUMBNAIL_CHANGE);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('renaming in the grid card', () => {
  it('passes only the name and description', async () => {
    const onUpdate = vi.fn(async () => {});
    await render(<ProjectCard project={PROJECT} {...handlers} onUpdate={onUpdate} />);
    const edit = container.querySelector('h3')?.parentElement?.querySelector<HTMLButtonElement>('button');
    expect(edit).not.toBeNull();
    await act(async () => { edit!.click(); });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith('p1', { name: 'Renamed', description: undefined });
    expect(toast.success).toHaveBeenCalledWith(en.projects.updated);
  });
});

describe('a thumbnail that could not be stored', () => {
  it('shows an error in the grid card', async () => {
    const onUpdate = vi.fn(async () => { throw new Error('Project not found: p1'); });
    await uploadWith(<ProjectCard project={PROJECT} {...handlers} onUpdate={onUpdate} />);
    expect(onUpdate).toHaveBeenCalledWith('p1', THUMBNAIL_CHANGE);
    expect(toast.error).toHaveBeenCalledWith(en.projects.updateFailed);
  });

  it('shows an error in the table row', async () => {
    const onUpdate = vi.fn(async () => { throw new Error('Project not found: p1'); });
    await uploadWith(<table><tbody><ProjectTableRow project={PROJECT} {...handlers} onUpdate={onUpdate} /></tbody></table>);
    expect(onUpdate).toHaveBeenCalledWith('p1', THUMBNAIL_CHANGE);
    expect(toast.error).toHaveBeenCalledWith(en.projects.updateFailed);
  });
});

describe('the table row menu', () => {
  it('names the JSON export on the item that runs it', async () => {
    const onExport = vi.fn();
    const onExportZip = vi.fn();
    await render(<table><tbody><ProjectTableRow project={PROJECT} {...handlers} onExport={onExport} onExportZip={onExportZip} onUpdate={vi.fn(async () => {})} /></tbody></table>);
    const trigger = container.querySelector('[aria-haspopup="menu"]');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((el) => el.textContent === en.projects.menu.exportJson);
    expect(item).toBeDefined();
    await act(async () => { item!.click(); });
    expect(onExport).toHaveBeenCalledWith(PROJECT);
    expect(onExportZip).not.toHaveBeenCalled();
  });
});
