// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A gallery edit in a tab that loaded before another tab saved (issue #29): the stored row's newer
 * name and saved checkpoint survive, and only the edited fields change.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const LOADED = vi.hoisted(() => ({
  id: 'p1', name: 'Site', createdAt: new Date(0), updatedAt: new Date(0),
  lastSavedCheckpointId: 'cp_old', lastSavedAt: new Date(0),
}));
const STORED = vi.hoisted(() => ({
  ...LOADED, name: 'Site renamed', lastSavedCheckpointId: 'cp_new', lastSavedAt: new Date(1000),
}));
const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listProjects: vi.fn(async () => [LOADED]),
  getProject: vi.fn(async () => ({ ...STORED })),
  updateProject: vi.fn(async () => {}),
  scheduleAutoSync: vi.fn(),
}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/template-service', () => ({ templateService: { listCustomTemplates: vi.fn(async () => []) } }));
vi.mock('@/lib/vfs/templates/preview-project', () => ({ sweepTemplatePreviewProjects: vi.fn(async () => {}) }));
vi.mock('@/components/guided-tour/context', () => ({
  useGuidedTour: () => ({ state: { status: 'idle' }, setProjectList: () => {}, start: () => {} }),
}));
vi.mock('@/components/guided-tour/overlay', () => ({ GuidedTourOverlay: () => null }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ useViewMode: () => ['grid', () => {}], ViewModeToggle: () => null }));
vi.mock('@/lib/hooks/use-narrow-container', () => ({ useNarrowContainer: () => [false, () => {}] }));
// The card shows the name and stands in for its thumbnail upload: it hands the manager the fields it changed.
vi.mock('../project-card', () => ({
  ProjectCard: ({ project, onUpdate }: { project: { id: string; name: string }; onUpdate: (id: string, changes: object) => void }) => (
    <button data-thumb={project.id} onClick={() => onUpdate(project.id, { previewImage: 'data:image/png;base64,x' })}>
      {project.name}
    </button>
  ),
}));

import { ProjectManager } from '..';
import { withMessages, registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => registerEnglishTranslator());

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a gallery edit from a stale tab', () => {
  it('keeps the name and saved checkpoint another tab stored', async () => {
    await act(async () => { root.render(withMessages(<ProjectManager onProjectSelect={() => {}} />)); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    const thumb = container.querySelector<HTMLButtonElement>('[data-thumb="p1"]');
    expect(thumb!.textContent).toBe('Site');
    await act(async () => { thumb!.click(); });

    expect(vfsMock.updateProject).toHaveBeenCalledTimes(1);
    expect(vfsMock.updateProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Site renamed',
      lastSavedCheckpointId: 'cp_new',
      lastSavedAt: new Date(1000),
      previewImage: 'data:image/png;base64,x',
    }));
    expect(vfsMock.scheduleAutoSync).toHaveBeenCalledWith('p1');
    expect(container.querySelector('[data-thumb="p1"]')!.textContent).toBe('Site renamed');
  });
});
